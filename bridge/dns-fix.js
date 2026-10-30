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
const inFlight = new Set();
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
  if (options && options.all) return callback(null, [{ address, family: 4 }]);
  return callback(null, address, 4);
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

    return original(hostname, options, (err, address, family) => {
      if (!err || err.code !== 'ENOTFOUND' || inFlight.has(hostname)) return done(err, address, family);
      inFlight.add(hostname);
      resolveViaDoh(hostname)
        .then((resolved) => {
          inFlight.delete(hostname);
          if (resolved) return reply(done, opts, resolved);
          return done(err, address, family);
        })
        .catch(() => {
          inFlight.delete(hostname);
          done(err, address, family);
        });
    });
  };
}