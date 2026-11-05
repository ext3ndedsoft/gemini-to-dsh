/**
 * Scoped egress for the bridge.
 *
 * A local CONNECT proxy that sits in front of the bridge process and decides, per
 * connection, whether the target host needs the upstream route or can go direct.
 * Only the hosts in `allow` (Google Cloud Code by default) ever touch the upstream
 * proxy — everything else is connected straight, so nothing outside Gemini is
 * affected by these settings.
 *
 * Node's env-proxy support is what makes this work without dependencies: the
 * bridge is started with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` pointing here,
 * so every `fetch` hands its CONNECT to us and we route it.
 *
 * Supported upstreams: http:// (CONNECT), https:// (CONNECT over TLS),
 * socks5:// and socks5h:// (remote DNS, the proxy resolves the name).
 */

import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startVpnWatch, vpnSnapshot } from './lib/vpn-detect.js';
import tls from 'node:tls';

export const CONFIG_FILE = process.env.AG_EGRESS_FILE || path.join(os.homedir(), '.dsh', 'ag-egress.json');

const DEFAULT_CONFIG = {
	enabled: true,
	proxy: '',
	relay: '',
	// How Google traffic leaves this machine:
	//   dns    = smart-DNS relay chain (route + routeChain)
	//   proxy  = one CONNECT proxy (proxy / fallbackProxy)
	//   vpn    = a system tunnel the user runs; we only report whether it is up
	//   direct = no relaying at all
	mode: 'dns',
	allow: ['*.googleapis.com', 'googleapis.com'],
	fallback: 'direct',
	connectTimeout: 15000,
	// Which channel carries Google traffic first, and what to try after it.
	// Channel names: 'proxy' (the proxy/fallbackProxy slots above), 'direct',
	// or any key of `providers`.
	route: 'bezmezhau',
	routeChain: ['bezmezhau', 'geohideeu', 'geohide', 'magicdns', 'direct'],
	// Smart-DNS channels. The resolver hands out the address of a relay that
	// routes by SNI, so we connect TCP there and still validate the real Google
	// certificate end to end. These are the public relays known to carry Cloud
	// Code at the time of writing; they are interchangeable, and a dead one is
	// simply skipped by the routing chain and the watchdog.
	providers: {
		bezmezhau: { dns: ['181.215.40.49', '31.58.216.201'], seeds: ['cloudaicompanion.googleapis.com'] },
		geohideeu: { dns: ['143.20.64.192', '45.13.237.213'], seeds: ['cloudaicompanion.googleapis.com'] },
		geohide: { dns: ['193.233.112.88', '193.233.112.67', '159.194.200.33'] },
		// MagicDNS only answers for the names it proxies. Its edge routes by SNI,
		// so any name it does answer yields an address that serves the rest too.
		magicdns: { dns: ['109.120.132.43', '94.249.177.102'], seeds: ['cloudaicompanion.googleapis.com'] }
	}
};

/** Transports the user can pick. */
export const MODES = ['dns', 'proxy', 'vpn', 'direct'];

/**
 * Mode is explicit, but a file written before it existed has no such field. Those files
 * carry a proxy slot or a disabled flag instead, so infer from what is actually there.
 */
function resolveMode(raw, merged) {
	if (MODES.includes(raw.mode)) return raw.mode;
	if (raw.enabled === false) return 'direct';
	if (merged.proxy || merged.fallbackProxy) return 'proxy';
	return 'dns';
}

/** Every channel a route may name. */
export function channelNames(config) {
	return ['proxy', ...Object.keys(config.providers || {}), 'direct'];
}

/** Human-readable state of the current mode, for the panel and for /vpn. */
export function describeMode(config) {
	const mode = resolveMode(config, config);
	if (mode === 'proxy') {
		const slot = config.proxy || config.fallbackProxy || '';
		return {
			mode,
			label: 'Proxy',
			ready: Boolean(slot),
			detail: slot ? maskProxy(slot) : 'proxy url is not set'
		};
	}
	if (mode === 'vpn') {
		const vpn = vpnSnapshot();
		return {
			mode,
			label: 'VPN',
			ready: Boolean(vpn.connected),
			detail: vpn.connected ? vpn.name || 'tunnel is up' : 'no VPN adapter is up'
		};
	}
	if (mode === 'direct') return { mode, label: 'Direct', ready: true, detail: 'no relay' };
	return { mode, label: 'DNS', ready: true, detail: routeChainOf(config).join(' > ') };
}

/** The ordered list of channels to attempt for one connection (always non-empty). */
/**
 * The same chain ordered by what was last measured: a channel that failed within the
 * freshness window is tried after the ones that carried traffic. The watchdog would
 * eventually rewrite the route, but its beat is a minute away and every request in
 * between pays a connect timeout for a leg that is known to be dead.
 */
const FAILURE_MEMORY_MS = Number(process.env.AG_FAILURE_MEMORY_MS || 120000);

export function requestChainOf(config) {
	const chain = routeChainOf(config);
	const now = Date.now();
	const failed = (name) => {
		const row = health.get(name);
		if (!row || !row.lastFailAt) return 0;
		return now - Date.parse(row.lastFailAt) < FAILURE_MEMORY_MS ? 1 : 0;
	};
	// Stable sort: unknown and healthy channels keep their configured order.
	return [...chain].sort((a, b) => failed(a) - failed(b));
}

export function routeChainOf(config) {
	const mode = resolveMode(config, config);
	// VPN and direct never relay: the tunnel, or the operating system, is the path.
	if (mode === 'vpn' || mode === 'direct') return ['direct'];
	// A single proxy is not a chain: try it, then fall back to a plain connection.
	if (mode === 'proxy') return ['proxy', 'direct'];
	const known = channelNames(config);
	const chain = [];
	for (const name of [config.route, ...(config.routeChain || [])]) {
		if (known.includes(name) && !chain.includes(name)) chain.push(name);
	}
	// Legacy `fallback: 'direct'` keeps meaning the same thing: end on a direct try.
	if (config.fallback === 'direct' && !chain.includes('direct')) chain.push('direct');
	return chain.length ? chain : ['direct'];
}

/**
 * Backfills fields that older config files (GeoHide-only) do not have.
 *
 * Presence is read from `raw` — the file as written — not from the merged
 * config, because the defaults already carry `providers` and `route` and would
 * make every legacy file look like a modern one.
 */
function routeOfDefaults(known) {
	return known.find((name) => name !== 'proxy' && name !== 'direct') || 'direct';
}

function normalizeConfig(raw, { fresh = false } = {}) {
	const config = { ...DEFAULT_CONFIG, ...raw };
	const providers = { ...DEFAULT_CONFIG.providers };
	for (const [name, spec] of Object.entries(raw.providers || {})) {
		providers[name] = { dns: Array.isArray(spec?.dns) ? spec.dns : [], ...spec };
	}
	// Legacy files predate channels: they configured one proxy plus an optional
	// GeoHide fallback. Their behaviour is reproduced exactly — a chain that never
	// knew about a new channel does not silently start using it.
	// A missing file is not an old file: the first run has to behave like the shipped
	// defaults, because a machine that never wrote a config has never chosen GeoHide.
	const legacy = !fresh && !raw.providers;
	const geohideOff = raw.geohideFallback === false;
	if (legacy && Array.isArray(raw.geohideDns) && raw.geohideDns.length) {
		providers.geohide = { ...providers.geohide, dns: raw.geohideDns };
	}
	const known = channelNames({ providers });
	const requested = typeof raw.route === 'string' ? raw.route : '';
	const route = known.includes(requested)
		? requested
		: legacy
			? config.proxy
				? 'proxy'
				: geohideOff
					? 'direct'
					: 'geohide'
			: known.includes(DEFAULT_CONFIG.route)
				? DEFAULT_CONFIG.route
				: routeOfDefaults(known);
	let routeChain;
	if (Array.isArray(raw.routeChain) && raw.routeChain.length) {
		routeChain = raw.routeChain.filter((name) => known.includes(name));
	} else if (legacy) {
		routeChain = [...new Set([route, ...(geohideOff ? [] : ['geohide']), 'direct'])];
	} else {
		routeChain = [...new Set([route, ...Object.keys(providers), 'direct'])];
	}
	return { ...config, route, routeChain, providers, mode: resolveMode(raw, config) };
}

/* ------------------------------------------------------------------ config */

let cache = { at: 0, config: null };

export function readConfig(force = false) {
	if (!force && cache.config && Date.now() - cache.at < 2000) return cache.config;
	cache = { at: Date.now(), config: normalizeConfig({}, { fresh: true }) };
	try {
		const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
		const parsed = JSON.parse(raw);
		cache.config = normalizeConfig(parsed);
	} catch {
		/* no file yet: defaults, which means direct */
	}
	if (process.env.AG_GOOGLE_PROXY) cache.config = { ...cache.config, enabled: true, proxy: process.env.AG_GOOGLE_PROXY };
	return cache.config;
}

export function writeConfig(patch) {
	const current = readConfig(true);
	const next = { ...current, ...patch };
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
	cache = { at: 0, config: null };
	return readConfig(true);
}

/** `*.googleapis.com` matches `daily-cloudcode-pa.googleapis.com` but not `googleapis.com.evil`. */
export function hostAllowed(host, allow) {
	const name = String(host || '').toLowerCase().replace(/\.$/, '');
	for (const pattern of allow || []) {
		const rule = String(pattern).toLowerCase().trim();
		if (!rule) continue;
		if (rule.startsWith('*.')) {
			const suffix = rule.slice(1);
			if (name.endsWith(suffix) && name.length > suffix.length) return true;
		} else if (name === rule) return true;
	}
	return false;
}

function parseProxy(url) {
	if (!url) return null;
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const protocol = parsed.protocol.replace(':', '');
	const host = parsed.hostname;
	const port = Number(parsed.port || (protocol.startsWith('socks') ? 1080 : 8080));
	if (!host || !port) return null;
	return {
		protocol,
		host,
		port,
		auth: parsed.username ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } : null
	};
}

/* --------------------------------------------------------------- transports */

function connectDirect(host, port, timeout) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`connect timeout ${host}:${port}`));
		}, timeout);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.setTimeout(0);
			resolve(socket);
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/**
 * Smart-DNS channel. The resolver returns the addresses of a relay for blocked
 * names; we connect TCP to that address and keep the original SNI, so the bridge
 * still validates the real Google certificate end to end. Which relay answers is
 * the only thing that changes between channels.
 */
// Remote resolvers are asked once per host per minute. A fresh query per
// connection cost more than the connect it was serving.
const dnsCache = new Map();
const DNS_TTL = Number(process.env.AG_EGRESS_DNS_TTL || 60000);

async function resolveViaSmartDns(host, servers, timeout) {
	const key = servers.join(',') + '|' + host;
	const hit = dnsCache.get(key);
	if (hit && Date.now() - hit.at < DNS_TTL) return hit.addresses;
	const resolver = new dns.promises.Resolver({ timeout: Math.max(2000, timeout), tries: 2 });
	resolver.setServers(servers);
	const addresses = await resolver.resolve4(host);
	if (!addresses?.length) throw new Error('no A records');
	dnsCache.set(key, { at: Date.now(), addresses });
	return addresses;
}

// The address that last carried a tunnel, per channel. Some relay legs accept
// TCP and then never forward a byte, so once one works we keep starting from it
// instead of walking the resolver order again for every connection.
const goodByChannel = new Map();

/** Drops cached DNS answers and the remembered edge for one channel. */
function forgetChannel(channel, config) {
	goodByChannel.delete(channel);
	const servers = new Set(config?.providers?.[channel]?.dns || []);
	if (!servers.size) return;
	for (const key of [...dnsCache.keys()]) {
		const holders = key.split('|')[0].split(',');
		if (holders.some((server) => servers.has(server))) dnsCache.delete(key);
	}
}

async function connectSmartDns(channel, spec, host, port, timeout) {
	const servers = spec?.dns;
	if (!Array.isArray(servers) || !servers.length) throw new Error(`${channel}: no dns servers configured`);
	let addresses;
	let seed = null;
	try {
		addresses = await resolveViaSmartDns(host, servers, timeout);
	} catch (error) {
		// The resolver may only answer for the names it proxies. The relay itself
		// routes by SNI, so an address learned from a seed name carries this host
		// just as well — the certificate is still validated against the real name.
		const seeds = Array.isArray(spec?.seeds) ? spec.seeds : [];
		for (const candidate of seeds) {
			try {
				addresses = await resolveViaSmartDns(candidate, servers, timeout);
				seed = candidate;
				break;
			} catch {
				/* try the next seed */
			}
		}
		if (!addresses) throw error;
	}
	const good = goodByChannel.get(channel);
	const ordered = good && addresses.includes(good)
		? [good, ...addresses.filter((address) => address !== good)]
		: addresses;
	let lastError = null;
	for (const address of ordered) {
		try {
			const socket = await connectDirect(address, port, timeout);
			goodByChannel.set(channel, address);
			socket.agRoute = seed ? `${channel} ${address} via ${seed}` : `${channel} ${address}`;
			return socket;
		} catch (error) {
			lastError = error;
			if (address === good) goodByChannel.delete(channel);
		}
	}
	throw lastError || new Error(`${channel}: every address failed`);
}

/** Reads exactly one HTTP header block from the socket. */
function readHttpHead(socket, timeout) {	return new Promise((resolve, reject) => {
		let buffer = '';
		const done = (error) => {
			socket.off('data', onData);
			socket.off('error', onError);
			clearTimeout(timer);
			if (error) reject(error);
		};
		const onData = (chunk) => {
			buffer += chunk.toString('latin1');
			const end = buffer.indexOf('\r\n\r\n');
			if (end === -1) return;
			done();
			resolve({ head: buffer.slice(0, end), rest: Buffer.from(buffer.slice(end + 4), 'latin1') });
		};
		const onError = (error) => done(error);
		const timer = setTimeout(() => {
			done();
			reject(new Error('proxy handshake timeout'));
		}, timeout);
		socket.on('data', onData);
		socket.once('error', onError);
	});
}

async function connectHttpProxy(proxy, host, port, timeout) {
	let socket = await connectDirect(proxy.host, proxy.port, timeout);
	if (proxy.protocol === 'https') {
		socket = await new Promise((resolve, reject) => {
			const secure = tls.connect({ socket, servername: proxy.host, rejectUnauthorized: true }, () => resolve(secure));
			secure.once('error', reject);
		});
	}
	const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: Keep-Alive'];
	if (proxy.auth) {
		const token = Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64');
		lines.push(`Proxy-Authorization: Basic ${token}`);
	}
	socket.write(`${lines.join('\r\n')}\r\n\r\n`);
	const { head } = await readHttpHead(socket, timeout);
	const status = Number(head.split(' ')[1] || 0);
	if (status !== 200) {
		socket.destroy();
		throw new Error(`proxy CONNECT ${status}: ${head.split('\r\n')[0]}`);
	}
	return socket;
}

async function connectSocks5(proxy, host, port, timeout) {
	const socket = await connectDirect(proxy.host, proxy.port, timeout);
	// A single reader with its own buffer: the proxy may pack several replies into
	// one TCP segment, and dropping those bytes stalls the handshake.
	let pending = Buffer.alloc(0);
	let wake = null;
	const onData = (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		if (wake) {
			const resume = wake;
			wake = null;
			resume();
		}
	};
	socket.on('data', onData);
	socket.setTimeout(timeout, () => socket.destroy(new Error('socks5 handshake timeout')));

	const read = async (size) => {
		while (pending.length < size) await new Promise((resolve) => (wake = resolve));
		const out = pending.subarray(0, size);
		pending = pending.subarray(size);
		return Buffer.from(out);
	};

	const finish = () => {
		socket.off('data', onData);
		socket.setTimeout(0);
		if (pending.length) socket.unshift(pending);
		pending = Buffer.alloc(0);
	};

	try {
		socket.write(proxy.auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
		const greeting = await read(2);
		if (greeting[0] !== 5) throw new Error('not a socks5 proxy');
		const method = greeting[1];
		if (method === 2) {
			if (!proxy.auth) throw new Error('socks5 proxy wants credentials');
			const user = Buffer.from(proxy.auth.user);
			const pass = Buffer.from(proxy.auth.pass);
			socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
			const authReply = await read(2);
			if (authReply[1] !== 0) throw new Error('socks5 auth rejected');
		} else if (method !== 0) {
			throw new Error(`socks5 wants an unsupported auth method ${method}`);
		}
		const name = Buffer.from(host);
		socket.write(
			Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([(port >> 8) & 0xff, port & 0xff])])
		);
		const reply = await read(4);
		if (reply[1] !== 0) throw new Error(`socks5 connect failed (code ${reply[1]})`);
		const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await read(1))[0];
		await read(addressLength + 2);
		finish();
		return socket;
	} catch (error) {
		socket.off('data', onData);
		socket.destroy();
		throw error;
	}
}

export async function connectViaProxy(url, host, port, timeout = 15000) {
	const proxy = parseProxy(url);
	if (!proxy) throw new Error(`invalid proxy url: ${url}`);
	if (proxy.protocol.startsWith('socks')) return connectSocks5(proxy, host, port, timeout);
	return connectHttpProxy(proxy, host, port, timeout);
}

/* ------------------------------------------------------------------- router */

/**
 * One HTTPS request to `target` through `proxy` (or direct when proxy is empty).
 * Used by the settings surface to prove a route actually reaches Google.
 */
export async function probe(url, { proxy = '', timeout = 20000 } = {}) {
	const target = new URL(url);
	const port = Number(target.port || 443);
	const socket = proxy ? await connectViaProxy(proxy, target.hostname, port, timeout) : await connectDirect(target.hostname, port, timeout);
	return new Promise((resolve, reject) => {
		const secure = tls.connect({ socket, servername: target.hostname }, () => {});
		let raw = '';
		const timer = setTimeout(() => {
			secure.destroy();
			reject(new Error('probe timeout'));
		}, timeout);
		secure.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		secure.on('data', (chunk) => {
			raw += chunk.toString('utf8');
		});
		secure.once('close', () => {
			clearTimeout(timer);
			const head = raw.split('\r\n\r\n')[0] || '';
			const status = Number((head.split('\r\n')[0] || '').split(' ')[1] || 0);
			resolve({ status, head, body: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
		});
		secure.once('end', () => secure.end());
		secure.write(
			`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`
		);
	});
}

/* ------------------------------------------------------------------- health */

// Per-channel counters, so the status surface can say which leg is actually
// carrying traffic and which one is quietly failing.
const health = new Map();

function markHealth(channel, ok, error, ms) {
	const entry = health.get(channel) || { ok: 0, fail: 0, lastError: null, lastOkAt: null, lastFailAt: null, lastMs: null };
	entry[ok ? 'ok' : 'fail'] += 1;
	if (ok) {
		entry.lastOkAt = new Date().toISOString();
		entry.lastMs = Math.round(ms || 0);
	} else {
		entry.lastError = error?.message || String(error);
		entry.lastFailAt = new Date().toISOString();
	}
	health.set(channel, entry);
}

function healthSnapshot(config) {
	const out = {};
	for (const channel of channelNames(config)) {
		const entry = health.get(channel);
		if (entry) out[channel] = { ...entry };
	}
	return out;
}

/**
 * Times one channel end to end: DNS answer, TCP connect, then a verified TLS
 * handshake against the real SNI. Verification stays on, so a relay that
 * substitutes its own certificate fails the sample instead of looking fast.
 */
export async function benchChannel(channel, config, { host = 'cloudaicompanion.googleapis.com', rounds = 3, timeout = 8000 } = {}) {
	const samples = [];
	let error = null;
	let edge = null;
	for (let i = 0; i < rounds; i += 1) {
		const started = performance.now();
		let socket = null;
		try {
			if (channel === 'proxy') {
				const slot = config.proxy || config.fallbackProxy;
				if (!slot) throw new Error('no proxy configured');
				socket = await connectViaProxy(slot, host, 443, timeout);
			} else if (channel === 'direct') {
				socket = await connectDirect(host, 443, timeout);
				edge = 'system dns';
			} else {
				socket = await connectSmartDns(channel, config.providers[channel], host, 443, timeout);
				edge = String(socket.agRoute || '').split(' ')[1] || null;
			}
			const secure = await new Promise((resolve, reject) => {
				const s = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => resolve(s));
				s.once('error', reject);
			});
			samples.push(performance.now() - started);
			secure.destroy();
		} catch (failure) {
			error = failure.code ? `${failure.code} ${failure.message}` : failure.message;
			try {
				socket?.destroy();
			} catch {
				/* already gone */
			}
		}
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		channel,
		edge,
		ok: samples.length,
		rounds,
		medianMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
		bestMs: sorted.length ? Math.round(sorted[0]) : null,
		samples: samples.map((n) => Math.round(n)),
		error: samples.length ? null : error
	};
}

export async function benchChannels(options = {}) {
	const config = options.config || readConfig(true);
	const host = options.host || 'cloudaicompanion.googleapis.com';
	// Benchmarking opens real connections, so it stays inside the allow list: a
	// caller must not be able to point the route layer at an arbitrary host — and on
	// a machine where a link-local address is filtered, an unbounded connect is how
	// this endpoint used to hang until the caller gave up.
	if (!hostAllowed(host, config.allow)) {
		throw new Error(`host not allowed: ${host}`);
	}
	const rows = [];
	for (const channel of channelNames(config)) {
		const row = await benchChannel(channel, config, { ...options, host });
		// An empty proxy slot is a configuration choice, not a failing leg.
		const configured = channel !== 'proxy' || Boolean(config.proxy || config.fallbackProxy);
		if (configured) markHealth(channel, row.ok > 0, row.error ? new Error(row.error) : null, row.medianMs || 0);
		rows.push(row);
	}
	return { host, at: new Date().toISOString(), route: config.route, chain: routeChainOf(config), rows };
}

/* ---------------------------------------------------------------- watchdog */

// The host whose edge we sample. It is the one the bridge actually calls, so a
// probe that passes means real traffic will pass too.
const PROBE_HOST = process.env.AG_WATCHDOG_HOST || 'daily-cloudcode-pa.googleapis.com';

// Google answers a request from an unsupported country with a refusal body, not with a
// dropped connection: the transport is fine, the route is useless.
const REGION_BLOCK = /not available in your country|not supported in your (country|region)|unsupported region|location is not supported/i;

function parseStatusLine(buffer) {
	const match = buffer.match(/^HTTP\/1\.[01]\s+(\d{3})/);
	return match ? Number(match[1]) : null;
}

/**
 * One channel, end to end: DNS, TCP, then a verified TLS handshake against the
 * real SNI. The handshake is the point — a relay leg can accept TCP forever and
 * never finish TLS, which is exactly how a channel dies while looking alive.
 */
export async function probeChannel(channel, config, { host = PROBE_HOST, timeout = 6000 } = {}) {
	// A dead resolver can burn ten seconds before it gives up, which would make the
	// verdict useless — so the whole sample runs against a hard deadline.
	const attemptTimeout = Math.max(1500, Math.min(3000, Math.floor(timeout / 2)));
	let socket = null;
	let settled = false;

	const work = (async () => {
		try {
			if (channel === 'direct') {
				socket = await connectDirect(host, 443, attemptTimeout);
			} else if (channel === 'proxy') {
				const slot = config.proxy || config.fallbackProxy;
				if (!slot) throw new Error('no proxy configured');
				socket = await connectViaProxy(slot, host, 443, attemptTimeout);
			} else {
				const spec = config.providers?.[channel];
				if (!spec) throw new Error(`${channel}: unknown channel`);
				socket = await connectSmartDns(channel, spec, host, 443, attemptTimeout);
			}
			// Read the edge before the handshake tears the socket down.
			const edge = String(socket?.remoteAddress || '') || null;
			// A finished handshake only proves the edge speaks TLS. An edge can complete the
			// handshake and then refuse the request itself — that is a channel that looks alive
			// while carrying nothing, and it is exactly how a blocked route kept winning the
			// chain. So ask for one real response and look at what comes back.
			const answer = await new Promise((resolve, reject) => {
				const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
					secure.write(
						`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: antigravity-bridge/probe\r\nConnection: close\r\n\r\n`
					);
				});
				let buffer = '';
				let quiet = null;
				const finish = (value) => {
					clearTimeout(quiet);
					try {
						secure.destroy();
					} catch {
						/* already gone */
					}
					resolve(value);
				};
				const settle = () => finish({ status: parseStatusLine(buffer), head: buffer.slice(0, 512) });
				secure.on('data', (chunk) => {
					buffer += chunk.toString('latin1');
					if (buffer.length >= 512) return settle();
					// The status line arrives first and often alone; a short grace period
					// lets a refusal body follow so the reason can be told apart from success.
					if (!quiet) quiet = setTimeout(settle, 150);
				});
				secure.once('end', settle);
				secure.once('error', (error) => {
					clearTimeout(quiet);
					reject(error);
				});
			});
			if (!answer.status) return { ok: false, error: 'edge closed without a response', edge };
			if (answer.status >= 400 && answer.status < 500 && REGION_BLOCK.test(answer.head)) {
				// A regional refusal is a dead route for this bridge even though the
				// transport works, which is the difference that matters here.
				return { ok: false, error: `edge refused for this region (${answer.status})`, edge, status: answer.status };
			}
			return { ok: true, edge, status: answer.status };
		} catch (error) {
			try {
				socket?.destroy();
			} catch {
				/* already gone */
			}
			return { ok: false, error: error.code ? `${error.code} ${error.message}` : error.message };
		} finally {
			settled = true;
		}
	})();

	let timer = null;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ ok: false, error: `no answer in ${timeout}ms` }), timeout);
	});

	const result = await Promise.race([work, deadline]);
	clearTimeout(timer);
	if (!settled) {
		try {
			socket?.destroy();
		} catch {
			/* already gone */
		}
	}
	return result;
}

/**
 * Same sample, shared. The watchdog, the /watchdog endpoint and a manual bench all ask
 * about the same channels within a minute of each other; probing each time means paying
 * three timeouts when Google is slow, which is how a request path ends up waiting on a
 * question someone else already answered.
 */
const probeCache = new Map();
const PROBE_TTL_MS = Number(process.env.AG_PROBE_TTL_MS || 30000);

export async function probeChannelCached(channel, config, { ttl = PROBE_TTL_MS, ...options } = {}) {
	const key = `${channel}|${options.host || PROBE_HOST}`;
	const hit = probeCache.get(key);
	if (hit && Date.now() - hit.at < ttl) return { ...hit.value, cached: true };
	const value = await probeChannel(channel, config, options);
	probeCache.set(key, { at: Date.now(), value });
	return value;
}

export function clearProbeCache() {
	probeCache.clear();
}

/**
 * Puts the winning channel first, keeps the rest in their existing order, and
 * optionally sends the channel that just died to the back. `direct` stays the end
 * of the line: a demoted channel goes after it, never before.
 */
export function promoteChannel(chain, winner, demote = null) {
	const rest = chain.filter((name) => name !== winner && name !== demote);
	if (demote) {
		const end = rest.indexOf('direct');
		if (end === -1) rest.push(demote);
		else rest.splice(end + 1, 0, demote);
	}
	return [winner, ...rest];
}

/**
 * Watches the live route and moves it when the channel stops carrying TLS.
 *
 * Runs outside the request path: it opens its own probe connection on a timer, so
 * an idle bridge never notices a dead leg and a busy one pays nothing. Two failed
 * probes in a row are the threshold, which skips single-packet hiccups. A switch is
 * only committed after the replacement passes the same probe, and the dead channel
 * goes to the back of the chain so the next fallback does not step on it first.
 */
export function createWatchdog({
	log = () => {},
	probe = probeChannelCached,
	apply = writeConfig,
	readConfig: read = readConfig,
	threshold = 2,
	intervalMs = Number(process.env.AG_WATCHDOG_MS || 120000)
} = {}) {
	const state = { route: null, failures: 0, lastProbeAt: null, lastSwitchAt: null, lastError: null, switches: 0 };
	let running = false;

	async function tick() {
		if (running) return state;
		running = true;
		try {
			const config = read(true);
			// Nothing to watch when routing is off or already direct: direct failing
			// means the machine itself has no network, and no channel can fix that.
			if (!config.enabled || !config.route || config.route === 'direct') return state;
			// VPN and direct are not ours to watch: a tunnel or the OS carries the traffic.
			if (config.mode === 'vpn' || config.mode === 'direct') return state;
			const current = config.route;
			if (state.route !== current) {
				// Someone picked a route by hand; that choice restarts the count.
				state.route = current;
				state.failures = 0;
			}
			state.lastProbeAt = new Date().toISOString();
			const sample = await probe(current, config);
			if (sample.ok) {
				state.failures = 0;
				state.lastError = null;
				return state;
			}
			state.failures += 1;
			state.lastError = `${current}: ${sample.error}`;
			log(`watchdog: ${current} probe failed (${state.failures}/${threshold}) — ${sample.error}`);
			if (state.failures < threshold) return state;

			for (const candidate of routeChainOf(config)) {
				if (candidate === current) continue;
				// direct means "no relay at all": when the machine can reach Google, it is
				// indistinguishable from a working channel, and when it cannot, it is the
				// problem. Promoting it would put a route the bridge cannot verify in front
				// of relays that do work.
				if (candidate === 'direct') continue;
				if (candidate === 'proxy' && !(config.proxy || config.fallbackProxy)) continue;
				const check = await probe(candidate, config);
				if (!check.ok) {
					log(`watchdog: ${candidate} is down too (${check.error})`);
					continue;
				}
				const chain = promoteChannel(routeChainOf(config), candidate, current);
				apply({ route: candidate, routeChain: chain });
				// The dead leg's cached answer would make the next probe test it again.
				forgetChannel(current, config);
				state.route = candidate;
				state.failures = 0;
				state.lastSwitchAt = new Date().toISOString();
				state.switches += 1;
				log(`watchdog: route ${current} -> ${candidate} (chain ${chain.join('>')})`);
				return state;
			}
			log(`watchdog: no channel passed the probe, staying on ${current}`);
			return state;
		} finally {
			running = false;
		}
	}

	return { state, tick, intervalMs };
}

/**
 * A fingerprint of the non-internal IPv4 addresses. Interfaces coming and going is the
 * cheap, portable signal that the machine changed networks — after that every cached
 * answer about which relay is alive is stale, because it was measured from somewhere else.
 */
function networkFingerprint() {
	const parts = [];
	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		for (const address of addresses || []) {
			if (address.internal) continue;
			if (address.family !== 'IPv4' && address.family !== 4) continue;
			parts.push(`${name}:${address.address}`);
		}
	}
	return parts.sort().join('|');
}

export function startNetworkWatch({ log = () => {}, intervalMs = Number(process.env.AG_NETWORK_MS || 10000) } = {}) {
	let last = networkFingerprint();
	let lastChange = null;
	const timer = setInterval(() => {
		const next = networkFingerprint();
		if (next === last) return;
		const before = last;
		last = next;
		lastChange = new Date().toISOString();
		clearProbeCache();
		const config = readConfig(true);
		for (const name of channelNames(config)) forgetChannel(name, config);
		log(`egress: network changed, dropped every cached channel answer`);
		return { before, after: next, at: lastChange };
	}, intervalMs);
	timer.unref();
	return { timer, state: () => ({ fingerprint: last, lastChange }) };
}

export function startEgress({ log = () => {}, port = 0 } = {}) {
	startVpnWatch();
	const networkWatch = startNetworkWatch({ log });
	readConfig(true); // a fresh shim never starts on a stale cached config
	const stats = { total: 0, proxied: 0, direct: 0, failed: 0, lastError: null, lastRoute: null, lastHost: null, lastAt: null };
	const watchdog = createWatchdog({ log });
	const watchdogTimer = setInterval(() => {
		watchdog.tick().catch((error) => log(`watchdog: tick failed (${error.message})`));
	}, watchdog.intervalMs);
	watchdogTimer.unref();

	// One serializer for the whole state, so the polled answer and the pushed one can never
	// disagree. The panel subscribes and sleeps instead of asking every five seconds.
	const describeState = () => {
		const live = readConfig();
		return {
			ok: true,
			stats,
			mode: live.mode,
			modeInfo: describeMode(live),
			vpn: vpnSnapshot(),
			route: live.route,
			chain: routeChainOf(live),
			channels: channelNames(live),
			health: healthSnapshot(live),
			watchdog: { ...watchdog.state, intervalMs: watchdog.intervalMs },
			network: networkWatch ? networkWatch.state() : null,
			config: {
				...live,
				proxy: live.proxy ? maskProxy(live.proxy) : '',
				fallbackProxy: live.fallbackProxy ? maskProxy(live.fallbackProxy) : ''
			}
		};
	};

	const sseClients = new Set();
	let lastPushed = '';
	const pushState = () => {
		if (!sseClients.size) return;
		let text;
		try {
			text = JSON.stringify(describeState());
		} catch {
			return;
		}
		// The watchdog stamps every tick, so a raw comparison would push a frame every few
		// seconds forever. Anything that matters for the panel is still compared.
		const key = text.replace(/"lastProbeAt":"[^"]*",?/, '');
		if (key === lastPushed) return;
		lastPushed = key;
		const frame = `data: ${text}\n\n`;
		for (const socket of sseClients) {
			try {
				socket.write(frame);
			} catch {
				sseClients.delete(socket);
			}
		}
	};
	const pushTimer = setInterval(pushState, 2500);
	pushTimer.unref();

	const server = net.createServer(async (client) => {
		client.on('error', () => {});
		const config = readConfig();
		let head;
		try {
			head = await readHttpHead(client, 20000);
		} catch {
			client.destroy();
			return;
		}
		const requestLine = (head.head.split('\r\n')[0] || '').trim();
		const [method, target] = requestLine.split(' ');

		// Anything that is not CONNECT is the settings surface (the DSH overlay and
		// the /ag command talk to it), so it answers JSON and allows the browser.
		if (method !== 'CONNECT') {
			// This port can rewrite the route, so it is not open to the browser at large: a
			// page on any origin would otherwise be able to send traffic somewhere else. Only
			// a loopback origin is echoed back, and a write from anywhere else is refused
			// before the body is read.
			const origin = (head.head.match(/^origin:[ \t]*(.+)$/im) || [])[1]?.trim();
			const loopbackOrigin = origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin);
			const cors = {
				'Access-Control-Allow-Headers': 'content-type',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				Vary: 'Origin'
			};
			if (!origin) cors['Access-Control-Allow-Origin'] = '*';
			else if (loopbackOrigin) cors['Access-Control-Allow-Origin'] = origin;
			const send = (status, payload) => {
				const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
				const head = [
					`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
					'Content-Type: application/json; charset=utf-8',
					`Content-Length: ${Buffer.byteLength(body)}`,
					'Connection: close',
					...Object.entries(cors).map(([key, value]) => `${key}: ${value}`)
				];
				client.end(`${head.join('\r\n')}\r\n\r\n${body}`);
			};
			if (method === 'OPTIONS') {
				send(200, { ok: true });
				return;
			}
			const declaredType = (head.head.match(/^content-type:[ \t]*(.+)$/im) || [])[1]?.trim().toLowerCase() || '';
			if (method === 'POST') {
				if (origin && !loopbackOrigin) {
					send(403, { ok: false, error: 'cross-origin writes are refused' });
					return;
				}
				// A text/plain POST is a simple request and would arrive without a preflight,
				// so the declared type has to be JSON for the body to count.
				if (!declaredType.startsWith('application/json')) {
					send(415, { ok: false, error: 'content-type must be application/json' });
					return;
				}
			}
			if (method === 'GET' && (target.startsWith('/bench') || target.startsWith('/watchdog') || target.startsWith('/events')) && origin && !loopbackOrigin) {
				send(403, { ok: false, error: 'cross-origin reads are refused' });
				return;
			}
			let body = head.rest || Buffer.alloc(0);
			if (method === 'POST') {
				const declared = Number((head.head.match(/content-length:\s*(\d+)/i) || [])[1] || 0);
				while (body.length < declared) {
					const chunk = await new Promise((resolve) => {
						client.once('data', resolve);
						client.once('end', () => resolve(null));
					});
					if (!chunk) break;
					body = Buffer.concat([body, chunk]);
				}
			}
			const describe = describeState;
			if (method === 'GET' && target.startsWith('/events')) {
				client.write(
					[
						'HTTP/1.1 200 OK',
						'Content-Type: text/event-stream; charset=utf-8',
						'Cache-Control: no-store',
						'Connection: keep-alive',
						'Access-Control-Allow-Origin: *',
						'',
						''
					].join('\r\n')
				);
				sseClients.add(client);
				client.on('close', () => sseClients.delete(client));
				client.on('error', () => sseClients.delete(client));
				try {
					client.write(`data: ${JSON.stringify(describeState())}\n\n`);
				} catch {
					sseClients.delete(client);
				}
				return;
			}
			if (method === 'GET' && target.startsWith('/bench')) {
				const query = new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?')) : '');
				const rounds = Math.min(10, Math.max(1, Number(query.get('rounds') || 3)));
				let bench;
				try {
					bench = await benchChannels({ host: query.get('host') || undefined, rounds });
				} catch (error) {
					if (!/host not allowed/.test(error.message)) throw error;
					send(400, { ok: false, error: error.message });
					return;
				}
				log(`egress: bench ${bench.host} -> ${bench.rows.map((row) => `${row.channel}=${row.medianMs ?? row.error}ms`).join(' ')}`);
				send(200, bench);
				return;
			}
			// On-demand watchdog pass: same code the timer runs, for a caller that
			// wants an answer now instead of waiting for the next scheduled beat.
			if (method === 'GET' && target.startsWith('/watchdog')) {
				await watchdog.tick();
				send(200, { ok: true, watchdog: { ...watchdog.state, intervalMs: watchdog.intervalMs }, route: readConfig().route });
				return;
			}
			if (method === 'POST') {
				let patch;
				try {
					patch = JSON.parse(body.toString('utf8') || '{}');
				} catch {
					send(400, { ok: false, error: 'body is not JSON' });
					return;
				}
				if (patch.mode !== undefined) {
					if (!MODES.includes(patch.mode)) {
						send(400, { ok: false, error: 'mode must be one of ' + MODES.join(', ') });
						return;
					}
					// Promising a proxy that is not configured would silently behave like direct.
					const live = readConfig();
					if (patch.mode === 'proxy' && !patch.proxy && !patch.fallbackProxy && !live.proxy && !live.fallbackProxy) {
						send(400, { ok: false, error: 'mode "proxy" needs a proxy url' });
						return;
					}
				}
				if (patch.proxy) {
					const parsed = parseProxy(patch.proxy);
					if (!parsed) {
						send(400, { ok: false, error: 'proxy must be http://, https://, socks5://host:port' });
						return;
					}
					patch.proxy = patch.proxy.trim();
				}
				if (patch.fallbackProxy) {
					const parsed = parseProxy(patch.fallbackProxy);
					if (!parsed) {
						send(400, { ok: false, error: 'fallbackProxy must be http://, https://, socks5://host:port' });
						return;
					}
					patch.fallbackProxy = patch.fallbackProxy.trim();
				}
				// A channel may be introduced and selected by the same request, so the
// incoming providers count as known before they are written.
				const incoming = patch.providers && typeof patch.providers === 'object' ? Object.keys(patch.providers) : [];
				const known = [...new Set([...channelNames(readConfig()), ...incoming])];
				if (patch.route !== undefined && !known.includes(patch.route)) {
					send(400, { ok: false, error: `route must be one of: ${known.join(', ')}` });
					return;
				}
				if (patch.routeChain !== undefined) {
					if (!Array.isArray(patch.routeChain)) {
						send(400, { ok: false, error: 'routeChain must be an array of channel names' });
						return;
					}
					const unknown = patch.routeChain.filter((name) => !known.includes(name));
					if (unknown.length) {
						send(400, { ok: false, error: `unknown channels: ${unknown.join(', ')}` });
						return;
					}
				}
				if (patch.providers !== undefined) {
					if (!patch.providers || typeof patch.providers !== 'object' || Array.isArray(patch.providers)) {
						send(400, { ok: false, error: 'providers must be an object of { name: { dns: [ip, ...] } }' });
						return;
					}
					for (const [name, spec] of Object.entries(patch.providers)) {
				// A null spec removes the channel: a custom DNS the user typed once should be
				// removable from the same panel it was added in.
				if (spec === null) {
					delete config.providers[name];
					continue;
				}
						if (!Array.isArray(spec?.dns) || !spec.dns.length) {
							send(400, { ok: false, error: `provider ${name} needs a non-empty dns array` });
							return;
						}
					}
				}
				writeConfig(patch);
				const updated = readConfig();
				log(`egress: settings updated (route=${updated.route}, chain=${routeChainOf(updated).join('>')})`);
				send(200, describe());
				return;
			}
			send(200, describe());
			return;
		}

		const lastColon = target.lastIndexOf(':');
		const host = target.slice(0, lastColon).replace(/^\[|\]$/g, '');
		const targetPort = Number(target.slice(lastColon + 1)) || 443;
		const allowed = hostAllowed(host, config.allow);
		// Only allowlisted hosts get routed; everything else always goes straight out.
		const chain = config.enabled && allowed ? requestChainOf(config) : ['direct'];

		stats.total += 1;
		stats.lastHost = host;
		stats.lastAt = new Date().toISOString();

		const reply = (socket) => {
			client.removeAllListeners('error');
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.rest?.length) socket.write(head.rest);
			client.pipe(socket).pipe(client);
			socket.on('error', () => client.destroy());
			client.on('close', () => socket.destroy());
		};

		// One CONNECT must answer inside the client's own connect timeout, otherwise the
// whole channel walk is invisible to it and it gives up first with UND_ERR_CONNECT_TIMEOUT.
		const deadline = Date.now() + Number(process.env.AG_EGRESS_BUDGET || 6000);

		for (const channel of chain) {
			const started = performance.now();
			const left = deadline - Date.now();
			if (left < 250) {
				log(`egress: out of time for ${host} before ${channel}`);
				break;
			}
			const perTry = Math.min(config.connectTimeout, left);
			// Direct is the last resort and the end of the line: no point trying the
			// next channel after the plain socket itself refused.
			if (channel === 'direct') {
				try {
					const socket = await connectDirect(host, targetPort, perTry);
					markHealth('direct', true, null, performance.now() - started);
					stats.direct += 1;
					stats.lastRoute = 'direct';
					reply(socket);
					return;
				} catch (error) {
					markHealth('direct', false, error);
					stats.failed += 1;
					stats.lastError = `${host} via direct: ${error.message}`;
					log(`egress: direct connect failed for ${host} (${error.message})`);
					continue;
				}
			}

			if (channel === 'proxy') {
				const slots = [config.proxy, config.fallbackProxy].filter(Boolean);
				if (!slots.length) continue;
				for (const proxy of slots) {
					try {
						const socket = await connectViaProxy(proxy, host, targetPort, perTry);
						markHealth('proxy', true, null, performance.now() - started);
						stats.proxied += 1;
						stats.lastRoute = proxy === config.proxy ? 'proxy' : 'proxy(fallback)';
						if (proxy !== config.proxy) log(`egress: primary proxy failed for ${host}, switched to the fallback proxy`);
						reply(socket);
						return;
					} catch (error) {
						markHealth('proxy', false, error);
						stats.failed += 1;
						stats.lastError = `${host} via ${maskProxy(proxy)}: ${error.message}`;
						log(`egress: proxy ${maskProxy(proxy)} failed for ${host} (${error.message})`);
					}
				}
				continue;
			}

			// Smart-DNS channel.
			try {
				const socket = await connectSmartDns(channel, config.providers[channel], host, targetPort, perTry);
				markHealth(channel, true, null, performance.now() - started);
				stats.proxied += 1;
				stats.lastRoute = channel;
				// Which edge actually carried the connection: without this a caller
				// cannot tell one relay from another when both tunnels open fine.
				log(`egress: ${host} via ${channel} @ ${socket.remoteAddress}`);
				if (channel !== chain[0]) log(`egress: ${host} switched to ${channel}`);
				reply(socket);
				return;
			} catch (error) {
				markHealth(channel, false, error);
				stats.failed += 1;
				stats.lastError = `${host} via ${channel}: ${error.message}`;
				log(`egress: ${channel} failed for ${host} (${error.message})`);
			}
		}

		client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			resolve({
				port: server.address().port,
				stats,
				watchdog: watchdog.state,
				close: () => {
					clearInterval(watchdogTimer);
					clearInterval(pushTimer);
					if (networkWatch) clearInterval(networkWatch.timer);
					for (const socket of sseClients) {
						try {
							socket.end();
						} catch {
							/* already closed */
						}
					}
					sseClients.clear();
					server.close();
				}
			});
		});
	});
}

export function maskProxy(url) {
	const proxy = parseProxy(url);
	if (!proxy) return '';
	return `${proxy.protocol}://${proxy.auth ? '***:***@' : ''}${proxy.host}:${proxy.port}`;
}