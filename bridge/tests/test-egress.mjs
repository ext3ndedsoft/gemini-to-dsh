/**
 * Egress test: proves the shim routes only allow-listed hosts through the
 * upstream proxy, keeps everything else direct, speaks both HTTP CONNECT and
 * SOCKS5, and falls back when the upstream is dead.
 *
 *   node test-egress.mjs
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(os.tmpdir(), `ag-egress-test-${Date.now()}.json`);
process.env.AG_EGRESS_FILE = CONFIG;
const egress = await import('../egress.js');

let failures = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/* ---------------------------------------------------------------- fake upstreams */

function startHttpProxy(onConnect) {
	const server = net.createServer((client) => {
		let buf = '';
		client.on('error', () => {});
		client.on('data', function onData(chunk) {
			buf += chunk.toString('latin1');
			if (!buf.includes('\r\n\r\n')) return;
			client.off('data', onData);
			const [, target] = buf.split('\r\n')[0].split(' ');
			const [host, port] = target.split(':');
			onConnect(`${host}:${port}`);
			const upstream = net.connect(Number(port), host, () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				client.pipe(upstream).pipe(client);
			});
			upstream.on('error', () => client.destroy());
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startSocks5Proxy(onConnect) {
	const server = net.createServer((client) => {
		let stage = 0;
		let host = '';
		let port = 0;
		client.on('error', () => {});
		client.on('data', (chunk) => {
			if (stage === 0) {
				client.write(Buffer.from([5, 0]));
				stage = 1;
				return;
			}
			if (stage === 1) {
				const length = chunk[4];
				host = chunk.subarray(5, 5 + length).toString();
				port = chunk.readUInt16BE(5 + length);
				onConnect(`${host}:${port}`);
				const upstream = net.connect(port, host, () => {
					client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
					client.pipe(upstream).pipe(client);
				});
				upstream.on('error', () => client.destroy());
				stage = 2;
			}
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const toUrl = (server, scheme) => `${scheme}://127.0.0.1:${server.address().port}`;
const shimUrl = (shim) => `http://127.0.0.1:${shim.port}`;

/* --------------------------------------------------------------------- rules */

check('allow: googleapis subdomain', egress.hostAllowed('daily-cloudcode-pa.googleapis.com', ['*.googleapis.com']));
check('allow: apex', egress.hostAllowed('googleapis.com', ['*.googleapis.com', 'googleapis.com']));
check('deny: lookalike suffix', !egress.hostAllowed('googleapis.com.evil.tld', ['*.googleapis.com']));
check('deny: unrelated host', !egress.hostAllowed('api.deepseek.com', ['*.googleapis.com']));
check('deny: bare suffix', !egress.hostAllowed('.googleapis.com', ['*.googleapis.com']));
check('mask hides credentials', egress.maskProxy('http://user:secret@1.2.3.4:8080') === 'http://***:***@1.2.3.4:8080');

/* ------------------------------------------------------------ http proxy path */

{
	const seen = [];
	const upstream = await startHttpProxy((target) => seen.push(target));
	fs.writeFileSync(CONFIG, JSON.stringify({ enabled: true, proxy: toUrl(upstream, 'http'), allow: ['example.com'], fallback: 'direct' }));
	const shim = await egress.startEgress({ port: 0 });

	const allowed = await egress.probe('https://example.com/', { proxy: shimUrl(shim) });
	check('http: allowed host answered', allowed.status === 200, `status ${allowed.status}`);
	check('http: allowed host went upstream', seen.includes('example.com:443'), seen.join(','));

	const blocked = await egress.probe('https://example.org/', { proxy: shimUrl(shim) });
	check('http: other host answered', blocked.status === 200, `status ${blocked.status}`);
	check('http: other host stayed direct', !seen.some((target) => target.startsWith('example.org')), seen.join(','));
	check('http: shim stats', shim.stats.proxied === 1 && shim.stats.direct === 1, JSON.stringify({ p: shim.stats.proxied, d: shim.stats.direct }));

	shim.close();
	upstream.close();
}

/* --------------------------------------------------------------- socks path */

{
	const seen = [];
	const socks = await startSocks5Proxy((target) => seen.push(target));
	fs.writeFileSync(CONFIG, JSON.stringify({ enabled: true, proxy: toUrl(socks, 'socks5'), allow: ['example.com'], fallback: 'direct' }));
	const shim = await egress.startEgress({ port: 0 });

	const result = await egress.probe('https://example.com/', { proxy: shimUrl(shim) });
	check('socks5: allowed host answered', result.status === 200, `status ${result.status}`);
	check('socks5: allowed host went upstream', seen.includes('example.com:443'), seen.join(','));

	shim.close();
	socks.close();
}

/* ------------------------------------------------------------ channel rules */

{
	fs.writeFileSync(
		CONFIG,
		JSON.stringify({
			enabled: true,
			providers: { alpha: { dns: ['1.1.1.1'] }, beta: { dns: ['2.2.2.2'] } },
			route: 'beta',
			routeChain: ['beta', 'alpha', 'nope', 'direct'],
			fallback: 'direct'
		})
	);
	const config = egress.readConfig(true);
	check(
		'channels: names listed',
		egress.channelNames(config).join(',') === 'proxy,bezmezhau,geohideeu,geohide,magicdns,alpha,beta,direct',
		egress.channelNames(config).join(',')
	);
	check('channels: unknown names dropped from chain', egress.routeChainOf(config).join('>') === 'beta>alpha>direct', egress.routeChainOf(config).join('>'));
}

{
	// A file written before channels existed must behave exactly as it used to:
	// GeoHide fallback still applies, and the new channel is not auto-appended.
	fs.writeFileSync(CONFIG, JSON.stringify({ enabled: true, geohideDns: ['1.1.1.1'], geohideFallback: true }));
	const config = egress.readConfig(true);
	check('legacy: route stays geohide', config.route === 'geohide', config.route);
	check('legacy: chain is geohide then direct', egress.routeChainOf(config).join('>') === 'geohide>direct', egress.routeChainOf(config).join('>'));
	check('legacy: magicdns is still selectable', egress.channelNames(config).includes('magicdns'));
	check('legacy: configured dns wins', config.providers.geohide.dns.join(',') === '1.1.1.1', config.providers.geohide.dns.join(','));
}

{
	// geohideFallback:false used to mean "never touch GeoHide" — still means it.
	fs.writeFileSync(CONFIG, JSON.stringify({ enabled: true, geohideFallback: false }));
	const config = egress.readConfig(true);
	check('legacy: geohide off goes direct', egress.routeChainOf(config).join('>') === 'direct', egress.routeChainOf(config).join('>'));
}

{
	// A machine with no config file at all must get the shipped chain, not the
	// legacy proxy fallback: the first run has to work where Google is blocked.
	// CONFIG_FILE is captured at import, so this has to be a fresh process.
	const missing = path.join(os.tmpdir(), `ag-egress-missing-${Date.now()}.json`);
	const script =
		"import('./egress.js').then(m=>{const c=m.readConfig(true);" +
		'console.log(JSON.stringify({route:c.route,chain:m.routeChainOf(c),enabled:c.enabled}))})';
	const raw = execFileSync(process.execPath, ['-e', script], {
		cwd: BRIDGE_DIR,
		env: { ...process.env, AG_EGRESS_FILE: missing },
		encoding: 'utf8'
	});
	const fresh = JSON.parse(raw.trim().split('\n').pop());
	check('fresh install: route is the shipped first channel', fresh.route === 'bezmezhau', fresh.route);
	check(
		'fresh install: full chain shipped',
		fresh.chain.join('>') === 'bezmezhau>geohideeu>geohide>magicdns>direct',
		fresh.chain.join('>')
	);
	check('fresh install: enabled by default', fresh.enabled === true, String(fresh.enabled));
}

/* ------------------------------------------------------------ dead upstream */

{
	fs.writeFileSync(
		CONFIG,
		JSON.stringify({
			enabled: true,
			proxy: 'http://127.0.0.1:1',
			allow: ['example.com'],
			route: 'proxy',
			routeChain: ['proxy', 'direct'],
			connectTimeout: 2000
		})
	);
	const shim = await egress.startEgress({ port: 0 });

	const result = await egress.probe('https://example.com/', { proxy: shimUrl(shim) });
	check('fallback: dead proxy still answered', result.status === 200, `status ${result.status}`);
	check('fallback: error recorded', Boolean(shim.stats.lastError), shim.stats.lastError || '');
	check('fallback: route marked direct', shim.stats.lastRoute === 'direct', String(shim.stats.lastRoute));

	shim.close();
}

/* --------------------------------------------------------- disabled / no proxy */

{
	fs.writeFileSync(CONFIG, JSON.stringify({ enabled: false, proxy: 'http://127.0.0.1:1', allow: ['example.com'] }));
	const shim = await egress.startEgress({ port: 0 });
	const result = await egress.probe('https://example.com/', { proxy: shimUrl(shim) });
	check('disabled: passthrough works', result.status === 200, `status ${result.status}`);
	check('disabled: nothing proxied', shim.stats.proxied === 0, JSON.stringify(shim.stats));
	shim.close();
}

/* ------------------------------------------------------- settings surface (HTTP) */

{
	// Everything above goes through CONNECT. The settings surface is a plain HTTP
	// request handled by the same socket, and it once referenced a variable that did
	// not exist — so any CLI call crashed the whole shim. Ask it directly.
	const shim = await egress.startEgress({ port: 0 });
	const ask = async (path, origin) => {
		const headers = origin ? { origin } : {};
		const response = await fetch(`${shimUrl(shim)}${path}`, { headers });
		return { status: response.status, headers: response.headers, body: await response.text() };
	};

	const describe = await ask('/');
	check('settings: describe answers over plain HTTP', describe.status === 200, `status ${describe.status}`);
	check('settings: describe is JSON', describe.body.startsWith('{'), describe.body.slice(0, 60));
	check('settings: no-origin is allowed', describe.headers.get('access-control-allow-origin') === '*');

	const loopback = await ask('/', 'http://127.0.0.1:3080');
	check(
		'settings: loopback origin echoed',
		loopback.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080',
		String(loopback.headers.get('access-control-allow-origin'))
	);

	const foreign = await ask('/', 'https://evil.example');
	check('settings: foreign origin not echoed', foreign.headers.get('access-control-allow-origin') === null, String(foreign.headers.get('access-control-allow-origin')));

	const watchdog = await ask('/watchdog');
	check('settings: /watchdog does not crash the shim', watchdog.status === 200, `status ${watchdog.status}`);
	check('settings: shim still listening', Boolean(shim.port));

	// CORS cannot stop a cross-site write: text/plain is a "simple" request and
	// runs without a preflight. The surface must refuse it on its own terms.
	const post = async (body, { origin, type = 'application/json' } = {}) => {
		const response = await fetch(`${shimUrl(shim)}/`, {
			method: 'POST',
			headers: { 'content-type': type, ...(origin ? { origin } : {}) },
			body: JSON.stringify(body)
		});
		return { status: response.status, body: await response.text() };
	};

	const before = egress.readConfig(true).proxy || '';
	const forged = await post({ proxy: 'http://127.0.0.1:9' }, { origin: 'https://evil.example', type: 'text/plain' });
	check('settings: cross-origin text/plain write refused', forged.status === 403, `status ${forged.status}`);
	check('settings: forged write changed nothing', (egress.readConfig(true).proxy || '') === before, egress.readConfig(true).proxy || '');

	const wrongType = await post({ proxy: 'http://127.0.0.1:9' }, { origin: 'http://127.0.0.1:3080', type: 'text/plain' });
	check('settings: non-JSON body refused', wrongType.status === 415, `status ${wrongType.status}`);

	const allowed = await post({ proxy: '' }, { origin: 'http://127.0.0.1:3080' });
	check('settings: loopback JSON write accepted', allowed.status === 200, `status ${allowed.status}`);

	// A proxy address is whatever the person was given: a bare host:port is normal, and a
	// scheme that is not a proxy scheme must be refused rather than read as HTTP.
	const bareWrite = await fetch(`http://127.0.0.1:${shim.port}/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
		body: JSON.stringify({ proxy: '127.0.0.1:3128', mode: 'proxy' })
	});
	check('proxy: bare host:port is accepted', bareWrite.status === 200, `status ${bareWrite.status}`);
	const bareBody = await bareWrite.json();
	check('proxy: bare host:port is stored as http', String(bareBody.config?.proxy || '').startsWith('http://'), bareBody.config?.proxy);

	const oddScheme = await fetch(`http://127.0.0.1:${shim.port}/`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
		body: JSON.stringify({ proxy: 'ftp://127.0.0.1:21', mode: 'proxy' })
	});
	check('proxy: a non-proxy scheme is refused', oddScheme.status === 400, `status ${oddScheme.status}`);

	const checked = await ask('/check?proxy=' + encodeURIComponent('http://127.0.0.1:1'));
	check('proxy: check reports a dead address instead of throwing', checked.status === 200, `status ${checked.status}`);
	const checkedBody = JSON.parse(await checked.text());
	check('proxy: check says not ok for a closed port', checkedBody.ok === false, JSON.stringify(checkedBody).slice(0, 80));

	// /watchdog runs a probe and /bench opens connections: neither is a read, so a
	// page must not be able to trigger them either.
	const probeForeign = await ask('/watchdog', 'https://evil.example');
	check('settings: /watchdog refuses a foreign origin', probeForeign.status === 403, `status ${probeForeign.status}`);

	const benchForeign = await ask('/bench', 'https://evil.example');
	check('settings: /bench refuses a foreign origin', benchForeign.status === 403, `status ${benchForeign.status}`);

	const benchSsrf = await ask('/bench?host=169.254.169.254', 'http://127.0.0.1:3080');
	check('settings: /bench refuses a host outside the allow list', benchSsrf.status === 400, `status ${benchSsrf.status}`);
	check('settings: refusal names the host rule', benchSsrf.body.includes('host not allowed'), benchSsrf.body.slice(0, 80));

	shim.close();
}

/* ------------------------------------------------------------------ watchdog */

{
	// A channel that answers TCP and then never finishes TLS is the shape of death
	// this guard exists for, so the fake probe fails while the leg still looks up.
	const config = {
		enabled: true,
		route: 'dead',
		routeChain: ['dead', 'live', 'direct'],
		providers: { dead: { dns: ['127.0.0.1'] }, live: { dns: ['127.0.0.2'] } }
	};
	const probes = [];
	const applied = [];
	const watchdog = egress.createWatchdog({
		readConfig: () => config,
		probe: async (channel) => {
			probes.push(channel);
			return channel === 'dead' ? { ok: false, error: 'ETIMEDOUT TLS' } : { ok: true };
		},
		apply: (patch) => {
			applied.push(patch);
			Object.assign(config, patch);
		},
		threshold: 2,
		log: () => {}
	});

	await watchdog.tick();
	check('watchdog: one failure does not switch', applied.length === 0 && watchdog.state.failures === 1, `failures ${watchdog.state.failures}`);

	await watchdog.tick();
	check('watchdog: second failure switches', applied.length === 1, JSON.stringify(applied[0] || null));
	check('watchdog: switched to the healthy channel', config.route === 'live', String(config.route));
	check('watchdog: dead channel demoted to the back', (applied[0]?.routeChain || []).at(-1) === 'dead', (applied[0]?.routeChain || []).join('>'));
	check('watchdog: counter reset after switch', watchdog.state.failures === 0, String(watchdog.state.failures));

	// A route picked by hand must clear the old streak, and direct is never watched.
	config.route = 'direct';
	const before = probes.length;
	await watchdog.tick();
	check('watchdog: direct is not watched', probes.length === before, probes.join(','));
}

{
	// Nothing alive anywhere: the guard must sit still instead of tearing the route.
	const config = { enabled: true, route: 'a', routeChain: ['a', 'b'], providers: { a: {}, b: {} } };
	const applied = [];
	const watchdog = egress.createWatchdog({
		readConfig: () => config,
		probe: async () => ({ ok: false, error: 'ECONNRESET TLS' }),
		apply: (patch) => applied.push(patch),
		threshold: 1,
		log: () => {}
	});
	await watchdog.tick();
	check('watchdog: no healthy candidate leaves the route alone', applied.length === 0 && config.route === 'a', String(config.route));
}

check(
	'promoteChannel: winner first, order kept',
	egress.promoteChannel(['a', 'b', 'c'], 'c').join('>') === 'c>a>b',
	egress.promoteChannel(['a', 'b', 'c'], 'c').join('>')
);
check(
	'promoteChannel: demoted channel lands after direct',
	egress.promoteChannel(['a', 'b', 'direct'], 'b', 'a').join('>') === 'b>direct>a',
	egress.promoteChannel(['a', 'b', 'direct'], 'b', 'a').join('>')
);

{
	// probeChannel must judge the handshake, not just the socket.
	const config = { providers: { deadns: { dns: ['127.0.0.1'] } } };
	const verdict = await egress.probeChannel('deadns', config, { timeout: 1500 });
	check('probeChannel: unusable channel reports failure', verdict.ok === false && Boolean(verdict.error), String(verdict.error));
}

fs.rmSync(CONFIG, { force: true });
console.log(failures ? `\n${failures} failed` : '\nall egress checks passed');
process.exit(failures ? 1 : 0);

