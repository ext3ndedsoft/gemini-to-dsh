/**
 * Launcher.
 *
 * Starts the scoped egress shim, then the bridge itself with Node's env-proxy
 * pointed at that shim. The shim decides per host: Google Cloud Code goes through
 * the configured upstream route, everything else is connected directly. Without a
 * proxy configured the shim is a transparent pass-through, so nothing changes.
 *
 * The bridge is a child process on purpose — `NODE_USE_ENV_PROXY` is read when
 * undici initialises, before any user code runs, so it has to be set in the
 * environment of a fresh process rather than at runtime.
 *
 *   node bridge.js        # normal start (also what DSH spawns)
 *   node server.js        # raw bridge, no egress routing
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The shim resolves names itself when it connects directly, so it needs the same
// DoH fallback the bridge uses — a poisoned resolver would break the direct path.
import './dns-fix.js';
import { readConfig, startEgress } from './egress.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EGRESS_PORT = Number(process.env.AG_EGRESS_PORT || 8789);

function log(message) {
	// stdout only: whoever started us (DSH supervisor, start.cmd) already redirects
	// it into bridge.log, and appending here too would duplicate every line.
	console.log(`[${new Date().toISOString()}] ${message}`);
}

const config = readConfig(true);
// Where Google is directly reachable the shim is a needless local hop, and for
// anyone outside that region it is the entire point. Two switch-offs, same effect:
// AG_EGRESS=0 in the environment, or "enabled": false in the egress config.
const wantEgress = process.env.AG_EGRESS !== '0' && config.enabled !== false;
let shim = null;
if (!wantEgress) {
	log('egress disabled: connecting directly, no shim');
} else {
	try {
		shim = await startEgress({ port: EGRESS_PORT, log });
		log(`egress shim on 127.0.0.1:${shim.port} · route=${config.route} · channels=${Object.keys(config.providers || {}).join(',') || 'none'}`);
	} catch (error) {
		log(`egress shim unavailable (${error.message}), starting direct`);
	}
}

const env = { ...process.env };
if (shim) {
	// Always route through the shim, even with no proxy configured: the shim is a
	// transparent direct connection then, and a proxy added later in the DSH
	// settings takes effect immediately instead of after a bridge restart.
	const url = `http://127.0.0.1:${shim.port}`;
	env.NODE_USE_ENV_PROXY = '1';
	env.HTTP_PROXY = url;
	env.HTTPS_PROXY = url;
	env.NO_PROXY = '127.0.0.1,localhost';
} else {
	delete env.NODE_USE_ENV_PROXY;
	delete env.HTTP_PROXY;
	delete env.HTTPS_PROXY;
}

const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
	cwd: HERE,
	env,
	stdio: 'inherit',
	windowsHide: true
});

child.on('error', (error) => {
	log(`failed to spawn server: ${error.message}`);
	process.exit(1);
});

child.on('exit', (code, signal) => {
	log(`server exited (${code ?? signal})`);
	if (shim) shim.close();
	process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		child.kill(signal);
	});
}

// Dying must not leave the server behind: it is the one holding the listening port.
process.on('exit', () => {
	try {
		child.kill();
	} catch {
		/* already gone */
	}
});