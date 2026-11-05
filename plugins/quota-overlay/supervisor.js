/**
 * Keeps the Antigravity bridge alive for as long as DSH runs.
 *
 * DSH boots → if nothing answers on the bridge port, `bridge.js` is spawned as a
 * child of this process; if it dies it is restarted with a short backoff, and it
 * is killed again when the plugin is disposed. An instance that is already
 * healthy (started by hand, or left over from an earlier DSH run) is adopted
 * instead of duplicated — the port is the lock.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Folder holding bridge.js. Override with AG_BRIDGE_DIR.
const DIR = process.env.AG_BRIDGE_DIR || path.join(os.homedir(), ".dsh", "bridge");
const BRIDGE_URL = process.env.AG_BRIDGE_URL || "http://127.0.0.1:8787";
const EGRESS_FILE = process.env.AG_EGRESS_FILE || path.join(os.homedir(), ".dsh", "ag-egress.json");
// Resolved through PATH by name; set WARP_CLI to an absolute path to override.
const WARP_CLI = process.env.WARP_CLI || "warp-cli";
const MAX_RESTARTS = 6;
const TUNNEL_CHECK_MS = 60_000;

function portOf(target) {
	try {
		return Number(new URL(target).port) || 8787;
	} catch {
		return 8787;
	}
}

/**
 * Resolve a bare command name through PATH (plus the usual Windows suffixes).
 * Returns null when nothing matches; a value containing a separator is checked as-is.
 */
function resolveOnPath(command) {
	if (/[\\/]/.test(command)) return fs.existsSync(command) ? command : null;
	const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		for (const suffix of suffixes) {
			const candidate = path.join(dir, command + suffix);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

async function healthy(timeout = 1500) {
	try {
		const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(timeout) });
		return res.ok;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------- tunnel */

/**
 * Port of the local proxy the egress shim is pointed at, or 0 when the shim goes
 * straight out. Only localhost proxies (Cloudflare WARP in proxy mode) are
 * something this process can revive by itself.
 */
function tunnelPort() {
	// A tunnel the user runs, or a deliberate direct connection, is not ours to revive.
	// WARP is only ever used as a local proxy for the smart-DNS research flow.
	if (mode() === 'vpn' || mode() === 'direct') return 0;
	try {
		const cfg = JSON.parse(fs.readFileSync(EGRESS_FILE, "utf8"));
		const url = new URL(cfg.proxy || "");
		if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return 0;
		return Number(url.port) || 0;
	} catch {
		return 0;
	}
}

function portOpen(port, timeout = 900) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const done = (value) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeout, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPort(port, tries = 10) {
	for (let i = 0; i < tries; i += 1) {
		if (await portOpen(port)) return true;
		await sleep(1000);
	}
	return false;
}

/**
 * Makes sure the WARP proxy the bridge egresses through is actually listening.
 * "Always On" reconnects the tunnel after a reboot, but a dropped session or a
 * client update can leave the port dead while the shim keeps pointing at it —
 * then every Google call fails and quota goes blank.
 */
function mode() {
	try {
		return String(JSON.parse(fs.readFileSync(EGRESS_FILE, 'utf8')).mode || 'dns');
	} catch {
		return 'dns';
	}
}

export async function ensureTunnel(log = () => {}) {
	const port = tunnelPort();
	if (!port) return { port: 0, up: false, skipped: true };
	if (await portOpen(port)) return { port, up: true, skipped: false };
	const warp = resolveOnPath(WARP_CLI);
	if (warp === null) {
		log(`tunnel: proxy 127.0.0.1:${port} is silent and "${WARP_CLI}" was not found on PATH`);
		return { port, up: false, skipped: false };
	}
	log(`tunnel: proxy 127.0.0.1:${port} is silent, asking WARP to reconnect`);
	const run = (...args) => {
		try {
			const res = spawnSync(warp, args, { timeout: 20000, windowsHide: true, encoding: "utf8" });
			return `${res.stdout || ""}${res.stderr || ""}`.trim();
		} catch (error) {
			return `spawn failed: ${error.message}`;
		}
	};
	run("connect");
	if (await waitForPort(port, 8)) return { port, up: true, skipped: false };
	const mode = run("mode", "proxy");
	run("proxy", "port", String(port));
	run("connect");
	const up = await waitForPort(port, 10);
	log(`tunnel: ${up ? "recovered" : `still down after reconnect (${mode.split("\n")[0] || "mode proxy"})`}`);
	return { port, up, skipped: false };
}

/** Returns a disposer; the health check runs in the background. */
export function superviseBridge(log = () => {}) {
	let child = null;
	let stopped = false;
	let restarts = 0;

	const launch = () => {
		if (stopped) return;
		const script = path.join(DIR, "bridge.js");
		if (!fs.existsSync(script)) {
			log(`bridge: ${script} not found, not starting`);
			return;
		}
		let out;
		let err;
		try {
			out = fs.openSync(path.join(DIR, "bridge.log"), "a");
			err = fs.openSync(path.join(DIR, "bridge.err.log"), "a");
		} catch (openError) {
			log(`bridge: cannot open log files (${openError.message})`);
			return;
		}
		try {
			child = spawn(process.execPath, ["bridge.js"], {				cwd: DIR,
				windowsHide: true,
				stdio: ["ignore", out, err],
				env: { ...process.env, AG_BRIDGE_PORT: String(portOf(BRIDGE_URL)) }
			});
		} finally {
			fs.closeSync(out);
			fs.closeSync(err);
		}
		log(`bridge: spawned pid ${child.pid} (port ${portOf(BRIDGE_URL)})`);
		child.on("exit", (code, signal) => {
			child = null;
			if (stopped) return;
			restarts += 1;
			if (restarts > MAX_RESTARTS) {
				log(`bridge: exited (${code ?? signal}) and hit the restart cap`);
				return;
			}
			const delay = Math.min(30000, 1000 * restarts);
			log(`bridge: exited (${code ?? signal}), restart ${restarts} in ${delay}ms`);
			setTimeout(launch, delay);
		});
		child.on("error", (error) => log(`bridge: spawn failed: ${error.message}`));
	};

	// The tunnel first: a dead WARP port makes every bridge call fail with a
	// timeout that looks like a Google outage.
	ensureTunnel(log)
		.catch(() => {})
		.finally(() =>
			healthy().then((up) => {
				if (stopped) return;
				if (up) {
					log("bridge: already listening, adopting the running instance");
					return;
				}
				launch();
			})
		);

	const tunnelTimer = setInterval(() => {
		if (stopped) return;
		ensureTunnel(log).catch(() => {});
	}, TUNNEL_CHECK_MS);

	return () => {
		stopped = true;
		clearInterval(tunnelTimer);
		if (child) {
			log(`bridge: stopping pid ${child.pid}`);
			// The bridge is a launcher with the actual server as its own child, so
			// kill the tree — otherwise a restart leaks a process holding the port.
			if (process.platform === "win32") {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			} else {
				child.kill();
			}
			child = null;
		}
	};
}