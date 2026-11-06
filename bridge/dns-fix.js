/**
 * DNS-over-HTTPS fallback.
 *
 * Some networks answer Google hosts with the resolver's own address or with
 * NXDOMAIN, which kills every Cloud Code call while plain HTTPS still works.
 * This patches `dns.lookup` — the hook Node's `net` (and therefore `fetch`) uses
 * — so an ENOTFOUND for an ordinary name is retried through DoH and the real
 * address is used. Everything else is untouched, and the patch is inert if DoH
 * itself is unreachable.
 *
 * AG_DNS_FALLBACK=0 disables it.
 */

import dns from 'node:dns';

const ENABLED = process.env.AG_DNS_FALLBACK !== '0';
const TTL = 300_000;
const DOH = [
  'https://cloudflare-dns.com/dns-query?type=A&name=',
  'https://dns.google/resolve?type=A&name=',
];

const cache = new Map();
/** hostname -> in-flight DoH lookup. */
const inFlight = new Map();
const original = dns.lookup.bind(dns);

async function resolveViaDoh(hostname) {
  const hit = cache.get(hostname);
  if (hit && Date.now() - hit.at < TTL) return hit.address;
  for (const base of DOH) {
    try {
      const res = await fetch(base + encodeURIComponent(hostname), {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const address = (json.Answer || []).find((answer) => answer.type === 1 && answer.data)?.data;
      if (address) {
        cache.set(hostname, { address, at: Date.now() });
        return address;
      }
    } catch {
      // try the next resolver
    }
  }
  return null;
}

function reply(callback, options, address) {
  // dns.lookup has to answer asynchronously: a cache hit used to call back in the
  // same tick, which re-enters net.connect from inside its own lookup call.
  process.nextTick(() => {
    if (options && options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  });
}

if (ENABLED) {
  dns.lookup = function lookupWithDoh(hostname, options, callback) {
    let opts = options;
    let done = callback;
    if (typeof opts === 'function') {
      done = opts;
      opts = {};
    } else if (typeof opts === 'number') {
      opts = { family: opts };
    }
    opts = opts || {};

    const cached = cache.get(hostname);
    if (cached && Date.now() - cached.at < TTL) return reply(done, opts, cached.address);

    return original(hostname, opts, (err, address, family) => {
      // The fallback only knows IPv4 answers, so an explicit AAAA request is left alone.
      if (!err || err.code !== 'ENOTFOUND' || opts.family === 6) return done(err, address, family);
      // A cold start resolves the same host from several sockets at once. They share
      // one DoH round trip; before, the later ones were handed ENOTFOUND while the
      // first was still waiting for the answer.
      let pending = inFlight.get(hostname);
      if (!pending) {
        pending = resolveViaDoh(hostname).finally(() => inFlight.delete(hostname));
        inFlight.set(hostname, pending);
      }
      pending
        .then((resolved) => {
          if (resolved) return reply(done, opts, resolved);
          return done(err, address, family);
        })
        .catch(() => done(err, address, family));
    });
  };
}