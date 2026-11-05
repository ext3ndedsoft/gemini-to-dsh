/**
 * Transport modes: dns / proxy / vpn / direct.
 *
 * The point of the mode field is that a choice made in the panel actually changes the
 * connection path and cannot silently degrade into something else. These checks pin that
 * down without touching the network: mode inference for old config files, the chain each
 * mode produces, the state the panel reads, the rejection of impossible combinations, and
 * the fact that the watchdog keeps its hands off a tunnel it does not own.
 *
 *   node tests/test-modes.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(os.tmpdir(), `ag-modes-test-${Date.now()}.json`);
process.env.AG_EGRESS_FILE = CONFIG;
process.env.AG_VPN_REFRESH_MS = '600000';

const egress = await import('../egress.js');
const { fetchQuotaSummary, flattenGroups, hubUserAgent } = await import('../lib/quota.js');

let failures = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const written = (patch) => {
	fs.writeFileSync(CONFIG, JSON.stringify(patch));
	return egress.readConfig(true);
};

/* ------------------------------------------------------------------ inference */

check(
	'infer: a proxy slot means proxy mode',
	written({ proxy: 'socks5://127.0.0.1:1080' }).mode === 'proxy',
	written({ proxy: 'socks5://127.0.0.1:1080' }).mode,
);

check('infer: a disabled shim means direct', written({ enabled: false }).mode === 'direct');

check('infer: nothing special stays on dns', written({}).mode === 'dns');

check(
	'explicit: mode wins over inference',
	written({ mode: 'vpn', proxy: 'socks5://127.0.0.1:1080' }).mode === 'vpn',
);

check('explicit: an unknown mode is ignored', written({ mode: 'carrier-pigeon' }).mode === 'dns');

/* --------------------------------------------------------------- route chains */

const CHANNELS = { alpha: { dns: ['192.0.2.1'] }, beta: { dns: ['192.0.2.2'] } };
const dns = written({ mode: 'dns', route: 'alpha', routeChain: ['alpha', 'beta'], providers: CHANNELS });
check('chain: dns keeps its channels', egress.routeChainOf(dns).join('>') === 'alpha>beta>direct', egress.routeChainOf(dns).join('>'));

const proxy = written({ mode: 'proxy', proxy: 'socks5://127.0.0.1:1080', route: 'alpha', providers: CHANNELS });
check('chain: proxy is tried first', egress.routeChainOf(proxy).join('>') === 'proxy>direct', egress.routeChainOf(proxy).join('>'));

const vpn = written({ mode: 'vpn', route: 'alpha', routeChain: ['alpha', 'beta'], providers: CHANNELS });
check('chain: vpn never relays', egress.routeChainOf(vpn).join('>') === 'direct', egress.routeChainOf(vpn).join('>'));

const direct = written({ mode: 'direct', route: 'alpha' });
check('chain: direct never relays', egress.routeChainOf(direct).join('>') === 'direct');

/* ------------------------------------------------------------------ panel view */

const proxyInfo = egress.describeMode(written({ mode: 'proxy', proxy: 'socks5://user:pass@127.0.0.1:1080' }));
check('panel: proxy is ready when addressed', proxyInfo.ready === true && proxyInfo.label === 'Proxy');
check('panel: proxy address is masked', !proxyInfo.detail.includes('pass') && proxyInfo.detail.includes('1080'), proxyInfo.detail);

const bareProxy = egress.describeMode(written({ mode: 'proxy' }));
check('panel: proxy without address is not ready', bareProxy.ready === false, bareProxy.detail);

const vpnInfo = egress.describeMode(written({ mode: 'vpn' }));
check('panel: vpn reports the tunnel state', vpnInfo.label === 'VPN' && typeof vpnInfo.detail === 'string', vpnInfo.detail);

const directInfo = egress.describeMode(written({ mode: 'direct' }));
check('panel: direct is always ready', directInfo.ready === true && directInfo.label === 'Direct');

const dnsInfo = egress.describeMode(
	written({ mode: 'dns', route: 'alpha', routeChain: ['alpha', 'beta'], providers: CHANNELS }),
);
check('panel: dns shows the chain', dnsInfo.detail.includes('alpha'), dnsInfo.detail);

/* ------------------------------------------------------------------- watchdog */

const watched = written({ mode: 'proxy', proxy: 'socks5://127.0.0.1:1080', route: 'alpha' });
const quiet = egress.createWatchdog({ readConfig: () => watched, probe: async () => ({ ok: false, error: 'dead' }) });
const state = await quiet.tick();
check('watchdog: proxy mode is watched', state.failures === 1, String(state.failures));

const tunnel = written({ mode: 'vpn', route: 'alpha' });
const handsOff = egress.createWatchdog({ readConfig: () => tunnel, probe: async () => ({ ok: false, error: 'dead' }) });
const untouched = await handsOff.tick();
check('watchdog: vpn is left alone', untouched.failures === 0 && untouched.lastProbeAt === null);

/* ------------------------------------------------------------------ quota read */

const realFetch = globalThis.fetch;
const calls = [];
try {
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), ua: init.headers['user-agent'], body: JSON.parse(init.body) });
		const payload = {
			groups: [
				{
					displayName: 'Gemini Models',
					description: 'Gemini Flash, Gemini Pro',
					buckets: [
						{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.62, resetTime: '2026-11-12T07:00:00Z' },
						{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.98, resetTime: '2026-11-05T12:00:00Z' },
					],
				},
				{ displayName: 'Empty group', buckets: [] },
			],
		};
		return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
	};

	const summary = await fetchQuotaSummary({ token: 'tok', project: 'proj' });
	check('quota: weekly bucket is read', summary.groups[0].weekly[0].remaining === 0.62);
	check('quota: five hour bucket is read', summary.groups[0].fiveHour[0].remaining === 0.98);
	check('quota: empty groups are dropped', summary.groups.length === 1);
	check('quota: the hub identity is sent', /^antigravity\/hub\/[\d.]+ \(aidev_client; os_type=\w+; arch=\w+\)$/.test(calls[0].ua), calls[0].ua);
	check('quota: the project travels in the body', calls[0].body.project === 'proj');
	check(
		'quota: the summary path is used',
		calls[0].url.endsWith('/v1internal:retrieveUserQuotaSummary'),
		calls[0].url,
	);
	check('quota: flatten keeps the group name', flattenGroups(summary.groups)[0].group === 'Gemini Models');
	check('quota: the identity names the platform', hubUserAgent().includes(`os_type=${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}`));

	// 403 with a project asks again without it, exactly like the desktop app does.
	calls.length = 0;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), body: JSON.parse(init.body) });
		if (calls.length === 1) return new Response('{}', { status: 403 });
		return new Response(JSON.stringify({ groups: [{ displayName: 'G', buckets: [{ bucketId: 'w', window: 'weekly', remainingFraction: 0.5 }] }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	const retried = await fetchQuotaSummary({ token: 'tok', project: 'proj' });
	check('quota: 403 with a project retries without one', retried && calls.length === 2 && !('project' in calls[1].body));

	// A rejected credential is terminal: no point asking three hosts with it.
	calls.length = 0;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return new Response('{}', { status: 401 });
	};
	const rejected = await fetchQuotaSummary({ token: 'tok', project: 'proj' });
	check('quota: 401 stops the lookup at once', rejected === null && calls.length === 1, `${calls.length} calls`);

	// No token, no lookup.
	check('quota: no token means no request', (await fetchQuotaSummary({ token: '' })) === null);
} finally {
	globalThis.fetch = realFetch;
	fs.rmSync(CONFIG, { force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall mode checks passed');
process.exit(failures ? 1 : 0);