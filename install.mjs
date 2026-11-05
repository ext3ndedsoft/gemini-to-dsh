#!/usr/bin/env node
/**
 * Installs the bridge and the quota panel into the DSH profile in one step.
 *
 * The manual route is three commands and a YAML edit, which is fine once and annoying to
 * describe to someone else. This does the same thing without asking anyone to hand-edit a
 * YAML file:
 *
 *   node install.mjs
 *
 * Layout it produces:
 *   ~/.dsh/bridge/                         bridge.js, server.js, egress.js, lib/, ...
 *   ~/.dsh/profiles/web/plugins/quota-overlay/
 *   ~/.dsh/profiles/web/cordis.patch.yml   one `insert` entry, appended if absent
 *
 * Safe to run twice: existing files are kept (`--force` overwrites), and the plugin entry is
 * recognised instead of added again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const dryRun = flag('dry-run');
const force = flag('force');
const pluginOnly = flag('plugin-only');
const bridgeOnly = flag('bridge-only');

const dshHome = path.resolve(value('dsh-home', process.env.AG_DSH_HOME || path.join(os.homedir(), '.dsh')));
const profile = value('profile', 'web');
const profileDir = path.join(dshHome, 'profiles', profile);
const pluginId = 'quota-overlay';

const log = (message) => console.log(`${dryRun ? 'would ' : ''}${message}`);
const fail = (message) => {
	console.error(`error: ${message}`);
	process.exit(1);
};

/* ------------------------------------------------------------------ checks */

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) fail(`Node 20 or newer is required, found ${process.version}`);

const bridgeSrc = path.join(repo, 'bridge');
if (!bridgeOnly && !fs.existsSync(bridgeSrc)) fail(`bridge folder not found next to install.mjs (${bridgeSrc})`);

const pluginSrc = path.join(repo, 'plugins', pluginId);
if (!bridgeOnly && !fs.existsSync(pluginSrc)) fail(`plugin folder not found (${pluginSrc})`);

if (!bridgeOnly && !fs.existsSync(profileDir)) {
	fail(
		`DSH profile not found: ${profileDir}\n` +
			`       start the DSH shell once, or pass --dsh-home / --profile`,
	);
}

/* ------------------------------------------------------------------ copying */

function copyTree(from, to, { skip = [] } = {}) {
	if (dryRun) {
		log(`copy ${path.relative(repo, from) || from} -> ${to}`);
		return 0;
	}
	let copied = 0;
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (skip.includes(entry.name)) continue;
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) {
			copied += copyTree(source, target, { skip });
			continue;
		}
		// Nothing is overwritten unless asked: a user's edited config stays theirs.
		if (fs.existsSync(target) && !force) continue;
		fs.copyFileSync(source, target);
		copied += 1;
	}
	return copied;
}

if (!pluginOnly) {
	const target = path.join(dshHome, 'bridge');
	const count = copyTree(bridgeSrc, target, { skip: ['node_modules', '.env'] });
	log(`bridge: ${count} file(s) -> ${target}`);
}

if (!bridgeOnly) {
	const target = path.join(profileDir, 'plugins', pluginId);
	const count = copyTree(pluginSrc, target);
	log(`plugin: ${count} file(s) -> ${target}`);
}

/* ------------------------------------------------------------ profile patch */

const patchFile = path.join(profileDir, 'cordis.patch.yml');
const ENTRY = [
	`    - id: ${pluginId}`,
	`      name: "./plugins/${pluginId}/index.js"`,
];

const HEADER = `# DSH profile patch.
# Generated entries below were appended by gemini-to-dsh/install.mjs.
`;

function patchProfile() {
	if (dryRun) {
		log(`add "${pluginId}" to ${patchFile}`);
		return;
	}

	const text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
	if (new RegExp(`^\\s*-?\\s*id:\\s*${pluginId}\\s*$`, 'm').test(text)) {
		log(`profile already lists "${pluginId}", leaving it alone`);
		return;
	}

	const lines = text ? text.split('\n') : [];
	const insertAt = lines.findIndex((line) => /^\s*-?\s*insert:\s*$/.test(line));

	let next;
	if (insertAt >= 0) {
		// Append to the existing list rather than opening a second `insert` key: YAML keeps
		// only the last one, and silently dropping plugins is worse than a bad error.
		const keyIndent = lines[insertAt].indexOf('insert');
		let end = insertAt + 1;
		while (end < lines.length) {
			const line = lines[end];
			const indent = line.length - line.trimStart().length;
			if (line.trim() && !line.trim().startsWith('#') && indent <= keyIndent) break;
			end += 1;
		}
		next = [...lines.slice(0, end), ...ENTRY, ...lines.slice(end)];
	} else {
		const block = ['- insert:', ...ENTRY];
		next = [...lines, ...(lines.length && lines[lines.length - 1].trim() ? [''] : []), ...block];
	}

	const body = next.join('\n');
	fs.writeFileSync(patchFile, text ? body : HEADER + body);
	log(`patched ${patchFile}`);
}

if (!bridgeOnly) patchProfile();

/* ------------------------------------------------------------------- report */

console.log('');
if (dryRun) {
	console.log('dry run: nothing was written');
} else {
	console.log('done.');
	console.log(`  bridge   ${pluginOnly ? '(skipped)' : path.join(dshHome, 'bridge')}`);
	console.log(`  plugin   ${bridgeOnly ? '(skipped)' : path.join(profileDir, 'plugins', pluginId)}`);
	console.log('');
	console.log('next:');
	console.log('  1. put Google credentials where the bridge can read them');
	console.log('     ~/.gemini/oauth_creds.json, or ~/.gemini/dsh-bridge/accounts.json');
	console.log('  2. restart the DSH shell — the panel appears in the bottom-right corner');
	console.log('  3. if Google is not reachable directly, pick a transport in the panel');
	console.log('');
	console.log('full walkthrough: docs/plugin-install.md');
}