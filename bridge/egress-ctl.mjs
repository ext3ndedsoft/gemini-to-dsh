/**
 * Egress control — switch which channel carries Gemini traffic, without
 * restarting the bridge.
 *
 * The shim reads its config file every 2 seconds, so a route change lands on the
 * next connection. This talks to the shim's own HTTP surface instead of editing
 * files, which means one command and no restart.
 *
 *   node egress-ctl.mjs status
 *   node egress-ctl.mjs use magicdns
 *   node egress-ctl.mjs chain magicdns geohide direct
 *   node egress-ctl.mjs bench --rounds=5
 *   node egress-ctl.mjs race --runs=2
 *   node egress-ctl.mjs on | off
 */

import { readConfig, channelNames, routeChainOf, maskProxy, CONFIG_FILE } from './egress.js';

const PORT = Number(process.env.AG_EGRESS_PORT || 8789);
const SHIM = `http://127.0.0.1:${PORT}`;
const BRIDGE = process.env.AG_BRIDGE_URL || 'http://127.0.0.1:8787';
const BRIDGE_KEY = process.env.AG_BRIDGE_KEY || 'local-bridge';

const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const flags = Object.fromEntries(
	argv
		.slice(1)
		.filter((a) => a.startsWith('--'))
		.map((a) => {
			const [key, ...rest] = a.replace(/^--/, '').split('=');
			return [key, rest.length ? rest.join('=') : true];
		})
);
const words = argv.slice(1).filter((a) => !a.startsWith('--'));

const pad = (value, width) => String(value ?? '-').padEnd(width);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shim(path = '/', init = {}) {
	const response = await fetch(`${SHIM}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers || {}) }
	});
	const text = await response.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`shim answered ${response.status} with non-JSON: ${text.slice(0, 200)}`);
	}
	if (!response.ok || payload.ok === false) throw new Error(payload.error || `shim answered ${response.status}`);
	return payload;
}

async function reachable() {
	try {
		await shim('/');
		return true;
	} catch {
		return false;
	}
}

function describeStatus(state) {
	console.log(`config    ${CONFIG_FILE}`);
	console.log(`enabled   ${state.config.enabled ? 'yes' : 'no'}   route ${state.route}   chain ${state.chain.join(' > ')}`);
	console.log('');
	console.log(`${pad('channel', 10)} ${pad('edge', 16)} ${pad('ok', 5)} ${pad('fail', 5)} ${pad('last ms', 8)} last error`);
	for (const channel of state.channels) {
		const health = state.health[channel] || {};
		const provider = state.config.providers?.[channel];
		const edge = channel === 'direct' ? 'system dns' : channel === 'proxy' ? state.config.proxy || '(not set)' : provider?.dns?.join(',') || '(no dns)';
		console.log(
			`${pad(channel, 10)} ${pad(edge, 16)} ${pad(health.ok ?? 0, 5)} ${pad(health.fail ?? 0, 5)} ${pad(health.lastMs ?? '-', 8)} ${health.lastError ?? ''}`
		);
	}
	const stats = state.stats || {};
	console.log('');
	console.log(`connections ${stats.total ?? 0}   routed ${stats.proxied ?? 0}   direct ${stats.direct ?? 0}   failed ${stats.failed ?? 0}`);
	if (stats.lastError) console.log(`last error  ${stats.lastError}`);
}

async function cmdStatus() {
	if (!(await reachable())) {
		const config = readConfig(true);
		console.log(`shim is not answering on ${SHIM} — showing the config file only`);
		console.log(`route ${config.route}   chain ${routeChainOf(config).join(' > ')}   enabled ${config.enabled ? 'yes' : 'no'}`);
		return;
	}
	describeStatus(await shim('/'));
}

async function cmdUse(channel) {
	if (!channel) throw new Error(`say which channel: ${channelNames(readConfig(true)).join(', ')}`);
	const state = await shim('/', { method: 'POST', body: JSON.stringify({ route: channel, enabled: true }) });
	console.log(`route -> ${state.route}   chain ${state.chain.join(' > ')}`);
	console.log('applies to the next connection, no restart needed');
}

async function cmdChain(channels) {
	if (!channels.length) throw new Error('give at least one channel');
	const state = await shim('/', { method: 'POST', body: JSON.stringify({ routeChain: channels, route: channels[0] }) });
	console.log(`route -> ${state.route}   chain ${state.chain.join(' > ')}`);
}

async function cmdToggle(enabled) {
	const state = await shim('/', { method: 'POST', body: JSON.stringify({ enabled }) });
	console.log(`egress routing ${state.config.enabled ? 'on' : 'off (every host goes direct)'}`);
}

async function cmdBench() {
	const rounds = Math.min(10, Math.max(1, Number(flags.rounds || 3)));
	const host = flags.host ? `?host=${encodeURIComponent(flags.host)}&rounds=${rounds}` : `?rounds=${rounds}`;
	const state = await shim(`/bench${host}`);
	console.log(`tcp+tls to ${state.host}, ${rounds} rounds each\n`);
	console.log(`${pad('channel', 10)} ${pad('median', 8)} ${pad('best', 7)} ${pad('ok', 5)} edge / error`);
	for (const row of state.rows) {
		const note = row.error ? row.error : row.edge || '';
		console.log(`${pad(row.channel, 10)} ${pad(row.medianMs ?? '-', 8)} ${pad(row.bestMs ?? '-', 7)} ${pad(`${row.ok}/${row.rounds}`, 5)} ${note}`);
	}
	console.log('\nlower median wins. this measures the route, not model thinking time.');
}

/**
 * Real end-to-end race: pin one channel, send the same completion through the
 * bridge, time the whole round trip. The chain is pinned to that single channel
 * on purpose — a broken channel must show up as broken, not as a silent
 * pass-through to direct.
 */
async function cmdRace() {
	const runs = Math.min(10, Math.max(1, Number(flags.runs || 2)));
	const parallel = Math.min(12, Math.max(1, Number(flags.parallel || 1)));
	const model = flags.model || 'gemini-3.8-flash';
	const prompt = flags.prompt || 'Reply with the single word: ready';
	const before = await shim('/');
	const only = flags.channels ? String(flags.channels).split(',') : null;
	const channels = channelNames(before.config).filter(
		(name) => (!only || only.includes(name)) && (name !== 'proxy' || before.config.proxy)
	);

	const oneCall = async () => {
		const started = Date.now();
		const response = await fetch(`${BRIDGE}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_KEY}` },
			body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 16 })
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 120)}`);
		return Date.now() - started;
	};

	console.log(`model ${model}, ${runs} run(s) per channel${parallel > 1 ? `, ${parallel} in flight` : ''}\n`);
	const results = [];
	try {
		for (const channel of channels) {
			await shim('/', { method: 'POST', body: JSON.stringify({ route: channel, routeChain: [channel] }) });
			const times = [];
			const failures = [];
			let wall = null;
			if (parallel > 1) {
				const started = Date.now();
				const settled = await Promise.allSettled(Array.from({ length: parallel }, oneCall));
				wall = Date.now() - started;
				for (const entry of settled) {
					if (entry.status === 'fulfilled') times.push(entry.value);
					else failures.push(entry.reason?.message || String(entry.reason));
				}
			} else {
				for (let i = 0; i < runs; i += 1) {
					try {
						times.push(await oneCall());
					} catch (failure) {
						failures.push(failure.message);
						break;
					}
				}
			}
			const sorted = [...times].sort((a, b) => a - b);
			const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
			results.push({ channel, median, wall, samples: times, failures });
			const verdict = times.length ? `${median} ms` : 'FAILED';
			const detail = failures.length
				? `${times.length} ok, ${failures.length} failed: ${failures[0]}`
				: times.join(', ');
			console.log(`${pad(channel, 10)} ${pad(verdict, 9)} ${wall ? `wall ${wall} ms  ` : ''}${detail}`);
		}
	} finally {
		await shim('/', { method: 'POST', body: JSON.stringify({ route: before.route, routeChain: before.config.routeChain }) });
		console.log(`\nroute restored to ${before.route}`);
	}
	const healthy = results.filter((row) => row.median !== null && !row.failures.length).sort((a, b) => a.median - b.median);
	if (healthy.length) {
		const best = healthy[0];
		console.log(`fastest with no failures: ${best.channel} (${best.median} ms)`);
		if (best.channel !== before.route) console.log(`pin it with:  node egress-ctl.mjs use ${best.channel}`);
	}
	const flaky = results.filter((row) => row.failures.length);
	if (flaky.length) console.log(`dropped connections: ${flaky.map((row) => `${row.channel} ${row.failures.length}x`).join(', ')}`);
}

/**
 * One completion, timed the way a person feels it: when the first token lands,
 * then how many tokens arrive per second. A channel can win the handshake and
 * still be useless for streaming, so screening has to end at the model.
 */
async function timedCompletion(model, prompt) {
	const started = Date.now();
	const response = await fetch(`${BRIDGE}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_KEY}` },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			max_tokens: 2500,
			reasoning_effort: 'minimal',
			stream: true,
			stream_options: { include_usage: true }
		})
	});
	if (!response.ok) {
		const text = await response.text();
		if (text.includes('location is not supported')) return { error: 'REGION' };
		const detail = text.match(/"message"\s*:\s*"([^"]{0,70})/);
		return { error: `${response.status}${detail ? ` ${detail[1]}` : ''}` };
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let firstTokenAt = null;
	let usage = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary;
		while ((boundary = buffer.indexOf('\n\n')) !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			for (const line of frame.split('\n')) {
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') continue;
				let json;
				try {
					json = JSON.parse(payload);
				} catch {
					continue;
				}
				if (json.usage) usage = json.usage;
				const delta = json.choices?.[0]?.delta || {};
				if (firstTokenAt === null && (delta.content || delta.reasoning_content)) firstTokenAt = Date.now() - started;
			}
		}
	}
	const totalMs = Date.now() - started;
	const tokens = usage?.completion_tokens ?? 0;
	const generationMs = totalMs - (firstTokenAt ?? 0);
	return { ttfb: firstTokenAt ?? 0, tokens, tps: generationMs > 0 ? Math.round((tokens / generationMs) * 1000) : 0 };
}

async function cmdAdd() {
	const name = words[0];
	const servers = words
		.slice(1)
		.join(',')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!name || !servers.length) throw new Error('usage: add <name> <dns ip> [<dns ip> ...] [--seeds=host]');
	const before = await shim('/');
	const seed = flags.seeds ? String(flags.seeds) : 'cloudaicompanion.googleapis.com';
	const providers = { ...before.config.providers, [name]: { dns: servers, seeds: [seed] } };
	const state = await shim('/', { method: 'POST', body: JSON.stringify({ providers }) });
	console.log(`channel ${name} -> ${servers.join(', ')}   seed ${seed}`);
	console.log(`channels now: ${channelNames(state.config).join(', ')}`);
	console.log(`test it with:  node egress-ctl.mjs check ${name}`);
}

/**
 * The screening test: pin a channel, make the model actually answer, report the
 * two numbers that matter. A burst of REGION rejections hits every channel at
 * once, so a failure is re-checked against the known-good control before the
 * channel is blamed.
 */
async function cmdCheck() {
	const runs = Math.min(6, Math.max(1, Number(flags.runs || 2)));
	const model = flags.model || 'gemini-3.8-flash';
	const prompt = flags.prompt || 'Напиши ровно 260 слов связного текста про научный прогресс: без списков и заголовков, сплошным абзацем.';
	const before = await shim('/');
	const control = flags.control ? String(flags.control) : before.route;
	const requested = words[0] && words[0] !== 'all' ? words[0] : null;
	const channels = (requested ? [requested] : channelNames(before.config)).filter(
		(name) => name !== 'proxy' || before.config.proxy
	);

	console.log(`Модель ${model}, прогонов на канал: ${runs}, контроль ${control}\n`);
	console.log(`${pad('канал', 11)} ${pad('ok', 5)} ${pad('ttfb', 7)} ${pad('t/s', 6)} примечание`);

	const rows = [];
	try {
		for (const channel of channels) {
			await shim('/', { method: 'POST', body: JSON.stringify({ route: channel, routeChain: [channel] }) });
			// Two things must expire before a route change is real: the shim's config
			// cache (2 s) and undici's keep-alive pool (4 s). A tunnel opened through
			// the previous channel is reused otherwise, so this call would still
			// leave through the old exit and inherit its verdict.
			await sleep(5200);

			const samples = [];
			for (let i = 0; i < runs; i += 1) {
				const sample = await timedCompletion(model, prompt);
				samples.push(sample);
				if (sample.error === 'REGION') break;
			}
			const good = samples.filter((sample) => !sample.error);
			const errors = [...new Set(samples.filter((sample) => sample.error).map((sample) => sample.error))];
			let note = errors.join(', ');
			let wave = false;
			if (!good.length && errors.includes('REGION') && channel !== control) {
				await shim('/', { method: 'POST', body: JSON.stringify({ route: control, routeChain: [control] }) });
				await sleep(5200);
				const verdict = await timedCompletion(model, prompt);
				wave = Boolean(verdict.error === 'REGION');
				if (wave) note += '  (волна: контроль тоже отказов)';
			}
			const row = {
				channel,
				ok: good.length,
				runs,
				wave,
				ttfb: good.length ? Math.round(good.reduce((sum, sample) => sum + sample.ttfb, 0) / good.length) : null,
				tps: good.length ? Math.round(good.reduce((sum, sample) => sum + sample.tps, 0) / good.length) : null,
				note
			};
			rows.push(row);
			console.log(`${pad(channel, 11)} ${pad(`${row.ok}/${row.runs}`, 5)} ${pad(row.ttfb ?? '-', 7)} ${pad(row.tps ?? '-', 6)} ${row.note}`);
		}
	} finally {
		await shim('/', { method: 'POST', body: JSON.stringify({ route: before.route, routeChain: before.config.routeChain }) });
		console.log(`\nМаршрут возвращён на ${before.route}`);
	}

	const ranked = rows.filter((row) => row.ok > 0).sort((a, b) => b.tps - a.tps);
	if (ranked.length) {
		const best = ranked[0];
		console.log(`быстрее всех: ${best.channel} — ${best.tps} t/s, первый токен ${best.ttfb} ms`);
		if (best.channel !== before.route) console.log(`закрепить:  node egress-ctl.mjs use ${best.channel}`);
	} else {
		console.log('ни один канал не ответил — если контроль тоже падал, это волна, попробуй позже');
	}
}

const commands = {
	status: cmdStatus,
	list: async () => {
		const config = readConfig(true);
		console.log(`channels: ${channelNames(config).join(', ')}`);
		console.log(`route:    ${config.route}`);
		console.log(`chain:    ${routeChainOf(config).join(' > ')}`);
		for (const [name, spec] of Object.entries(config.providers)) console.log(`  ${pad(name, 10)} ${spec.dns.join(', ')}`);
		if (config.proxy) console.log(`  ${pad('proxy', 10)} ${maskProxy(config.proxy)}`);
	},
	use: () => cmdUse(words[0]),
	chain: () => cmdChain(words),
	add: cmdAdd,
	check: cmdCheck,
	bench: cmdBench,
	race: cmdRace,
	on: () => cmdToggle(true),
	off: () => cmdToggle(false)
};

const run = commands[command];
if (!run) {
	console.log(`unknown command: ${command}`);
	console.log(`try: ${Object.keys(commands).join(' | ')}`);
	process.exit(1);
}
try {
	await run();
} catch (error) {
	console.error(`\n${error.message}`);
	process.exit(1);
}