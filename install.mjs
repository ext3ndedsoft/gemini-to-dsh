#!/usr/bin/env node
/**
 * gemini-to-dsh installer: one command, safe to repeat.
 *
 *   node install.mjs                          bridge + quota panel
 *   node install.mjs --with web-search,lean-context   plus extra plugins (or --all)
 *   node install.mjs --uninstall              remove plugins and profile entries (bridge is kept)
 *   node install.mjs --dry-run                show what would happen, write nothing
 *
 * Options: --profile <name>  --dsh-home <dir>  --keep (do not overwrite changed files)
 *          --plugin-only | --bridge-only
 *
 * Without a clone it works too: download this one file and run it, and it fetches the
 * sources itself (git if available, otherwise the GitHub tarball + tar).
 *
 * What it does:
 *   1. finds the DSH profile (web, or the only one that exists)
 *   2. copies bridge/ to ~/.dsh/bridge, updating changed code but never touching
 *      .env, node_modules or your ag-egress.json
 *   3. copies the plugins into <profile>/plugins and lists them in cordis.patch.yml
 *      (backup saved once as .bak)
 *   4. syntax-checks what it installed and tells you whether Google credentials are in place
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = "ext3ndedsoft/gemini-to-dsh";
const ALL_PLUGINS = ["quota-overlay", "web-search", "lean-context"];
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

if (flag("help") || flag("h")) {
	console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*\*\n|^ \* ?/gm, ""));
	process.exit(0);
}

const dryRun = flag("dry-run");
const keep = flag("keep");
const pluginOnly = flag("plugin-only");
const bridgeOnly = flag("bridge-only");
const uninstall = flag("uninstall");
const dshHome = path.resolve(value("dsh-home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));

const log = (message) => console.log(`${dryRun ? "would " : ""}${message}`);
const fail = (message) => {
	console.error(`error: ${message}`);
	process.exit(1);
};

if (Number(process.versions.node.split(".")[0]) < 20) fail(`Node 20 or newer is required, found ${process.version}`);

/* ------------------------------------------------------------------ profile */

function pickProfile() {
	const wanted = value("profile", null);
	const root = path.join(dshHome, "profiles");
	if (wanted) return wanted;
	if (fs.existsSync(path.join(root, "web"))) return "web";
	const found = fs.existsSync(root)
		? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		: [];
	if (found.length === 1) return found[0];
	fail(
		found.length
			? `several DSH profiles found (${found.join(", ")}); choose one with --profile <name>`
			: `no DSH profile under ${root}; start the DSH shell once, or pass --dsh-home / --profile`,
	);
}

const profile = pickProfile();
const profileDir = path.join(dshHome, "profiles", profile);
if (!fs.existsSync(profileDir)) fail(`DSH profile not found: ${profileDir}`);
const pluginsDir = path.join(profileDir, "plugins");
const patchFile = path.join(profileDir, "cordis.patch.yml");
const bridgeDir = path.join(dshHome, "bridge");

/* ------------------------------------------------------------------ sources */

let cleanup = null;

function resolveSources() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	if (fs.existsSync(path.join(here, "bridge")) && fs.existsSync(path.join(here, "plugins"))) return here;

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-src-"));
	cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
	console.log("sources not found next to the installer, downloading them");

	const clone = spawnSync("git", ["clone", "--depth", "1", `https://github.com/${REPO}.git`, tmp], { stdio: "ignore" });
	if (clone.status === 0) return tmp;

	return fetchTarball(tmp);
}

function fetchTarball(tmp) {
	// Synchronous on purpose: the installer is a straight line, not a service.
	const script = `const r=await fetch(process.argv[1]);if(!r.ok)process.exit(2);require("node:fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))`;
	const archive = path.join(tmp, "src.tar.gz");
	const get = spawnSync(process.execPath, ["--input-type=module", "-e", script.replace('require("node:fs")', "(await import('node:fs'))"), `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`, archive], { stdio: "inherit" });
	if (get.status !== 0) fail("could not download the sources; check the network or clone the repository by hand");
	const out = path.join(tmp, "repo");
	fs.mkdirSync(out);
	const untar = spawnSync("tar", ["-xzf", archive, "-C", out, "--strip-components=1"], { stdio: "inherit" });
	if (untar.status !== 0) fail("could not unpack the archive (tar is missing); clone the repository by hand");
	return out;
}

/* ------------------------------------------------------------------ copying */

function copyTree(from, to, stats = { added: 0, updated: 0, same: 0 }, skip = []) {
	if (!dryRun) fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (entry.name === "node_modules" || skip.includes(entry.name)) continue;
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) {
			copyTree(source, target, stats, skip);
			continue;
		}
		const incoming = fs.readFileSync(source);
		if (!fs.existsSync(target)) {
			stats.added += 1;
		} else if (fs.readFileSync(target).equals(incoming)) {
			stats.same += 1;
			continue;
		} else if (keep) {
			stats.same += 1;
			continue;
		} else {
			stats.updated += 1;
		}
		if (!dryRun) fs.writeFileSync(target, incoming);
	}
	return stats;
}

/* ------------------------------------------------------------ profile patch */

const HEADER = `# DSH profile patch.\n# Entries below were added by gemini-to-dsh/install.mjs.\n`;
const entryFor = (id) => [`    - id: ${id}`, `      name: "./plugins/${id}/index.js"`];
const idPattern = (id) => new RegExp(`^\\s*-?\\s*id:\\s*${id}\\s*$`);
const hasEntry = (text, id) => text.split(/\r?\n/).some((line) => idPattern(id).test(line));

function backupOnce() {
	const backup = `${patchFile}.bak`;
	if (fs.existsSync(patchFile) && !fs.existsSync(backup) && !dryRun) fs.copyFileSync(patchFile, backup);
}

function addEntry(id) {
	const text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
	if (hasEntry(text, id)) return log(`profile already lists "${id}"`);
	if (dryRun) return log(`add "${id}" to ${patchFile}`);
	backupOnce();

	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text ? text.split(/\r?\n/) : [];
	const insertAt = lines.findIndex((line) => /^\s*-?\s*insert:\s*$/.test(line));
	let next;
	if (insertAt >= 0) {
		// Extend the existing list: YAML keeps only the last `insert` key, so a second one
		// would silently drop the plugins above it.
		const keyIndent = lines[insertAt].indexOf("insert");
		let end = insertAt + 1;
		while (end < lines.length) {
			const line = lines[end];
			const indent = line.length - line.trimStart().length;
			if (line.trim() && !line.trim().startsWith("#") && indent <= keyIndent) break;
			end += 1;
		}
		while (end > insertAt + 1 && !lines[end - 1].trim()) end -= 1;
		next = [...lines.slice(0, end), ...entryFor(id), ...lines.slice(end)];
	} else {
		next = [...lines, ...(lines.length && lines[lines.length - 1].trim() ? [""] : []), "- insert:", ...entryFor(id)];
	}
	const body = next.join(eol);
	fs.writeFileSync(patchFile, text ? body : HEADER + body);
	log(`patched ${patchFile} (+${id})`);
}

function removeEntry(id) {
	if (!fs.existsSync(patchFile)) return;
	const text = fs.readFileSync(patchFile, "utf8");
	if (!hasEntry(text, id)) return log(`profile does not list "${id}"`);
	if (dryRun) return log(`remove "${id}" from ${patchFile}`);
	backupOnce();
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const kept = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (idPattern(id).test(lines[i])) {
			if (/^\s*name:/.test(lines[i + 1] || "")) i += 1;
			continue;
		}
		kept.push(lines[i]);
	}
	// An `insert:` left with nothing under it is an invalid patch; drop it too.
	const at = kept.findIndex((line) => /^\s*-?\s*insert:\s*$/.test(line));
	if (at >= 0) {
		const rest = kept.slice(at + 1);
		const stop = rest.findIndex((line) => line.trim() && !/^\s+/.test(line));
		const block = stop >= 0 ? rest.slice(0, stop) : rest;
		if (!block.some((line) => /\bid:/.test(line))) kept.splice(at, 1);
	}
	fs.writeFileSync(patchFile, kept.join(eol));
	log(`removed "${id}" from ${patchFile}`);
}

/* ------------------------------------------------------------------- verify */

function checkSyntax(dir) {
	const broken = [];
	for (const name of fs.readdirSync(dir)) {
		if (!/\.(m?js|cjs)$/.test(name)) continue;
		const result = spawnSync(process.execPath, ["--check", path.join(dir, name)], { encoding: "utf8" });
		if (result.status !== 0) broken.push(`${name}: ${(result.stderr || "").split("\n")[0]}`);
	}
	return broken;
}

function credentialsReport() {
	const first = process.env.AG_CREDS_FILE || path.join(os.homedir(), ".gemini", "oauth_creds.json");
	const set = process.env.AG_ACCOUNTS_FILE || path.join(os.homedir(), ".gemini", "dsh-bridge", "accounts.json");
	const client = Boolean(process.env.AG_CLIENT_ID && process.env.AG_CLIENT_SECRET) || fs.existsSync(path.join(dshHome, "ag-oauth.json"));
	const mark = (ok) => (ok ? "found  " : "missing");
	console.log(`  ${mark(fs.existsSync(first))} account      ${first}`);
	console.log(`  ${mark(fs.existsSync(set))} account set  ${set}  (optional, for rotation)`);
	console.log(`  ${mark(client)} OAuth client AG_CLIENT_ID / AG_CLIENT_SECRET or ${path.join(dshHome, "ag-oauth.json")}`);
}

/* --------------------------------------------------------------------- main */

const withList = (value("with", "") || "").split(",").map((name) => name.trim()).filter(Boolean);
const wanted = bridgeOnly ? [] : flag("all") ? ALL_PLUGINS : ["quota-overlay", ...withList];
for (const id of wanted) if (!ALL_PLUGINS.includes(id)) fail(`unknown plugin "${id}"; available: ${ALL_PLUGINS.join(", ")}`);

try {
	if (uninstall) {
		for (const id of ALL_PLUGINS) {
			const dir = path.join(pluginsDir, id);
			if (fs.existsSync(dir)) {
				if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
				log(`removed ${dir}`);
			}
			removeEntry(id);
		}
		console.log(`\n${dryRun ? "dry run: nothing was written" : "done."} The bridge in ${bridgeDir} was kept (it holds your config); delete it by hand if you want it gone.`);
		console.log("restart the DSH shell to unload the plugins");
	} else {
		const root = resolveSources();
		const bridgeSrc = path.join(root, "bridge");
		if (!pluginOnly && !fs.existsSync(bridgeSrc)) fail(`bridge folder not found (${bridgeSrc})`);

		let changed = 0;
		if (!pluginOnly) {
			const stats = copyTree(bridgeSrc, bridgeDir, undefined, [".env", "ag-egress.json"]);
			changed += stats.added + stats.updated;
			log(`bridge: ${stats.added} added, ${stats.updated} updated, ${stats.same} unchanged -> ${bridgeDir}`);
		}
		for (const id of wanted) {
			const source = path.join(root, "plugins", id);
			if (!fs.existsSync(source)) fail(`plugin folder not found (${source})`);
			const target = path.join(pluginsDir, id);
			const stats = copyTree(source, target);
			changed += stats.added + stats.updated;
			log(`plugin ${id}: ${stats.added} added, ${stats.updated} updated, ${stats.same} unchanged`);
			addEntry(id);
		}

		if (!dryRun) {
			const dirs = [...(pluginOnly ? [] : [bridgeDir, path.join(bridgeDir, "lib")]), ...wanted.map((id) => path.join(pluginsDir, id))];
			const broken = dirs.flatMap((dir) => checkSyntax(dir));
			if (broken.length) fail(`installed files do not parse:\n  ${broken.join("\n  ")}`);
			log("syntax check passed");
		}

		console.log("");
		if (dryRun) {
			console.log("dry run: nothing was written");
		} else {
			console.log(`done. profile "${profile}", ${changed ? "installed" : "already up to date"}.`);
			console.log("");
			console.log("credentials:");
			credentialsReport();
			console.log("");
			console.log("next:");
			console.log("  1. put the missing credentials in place (see README, section Accounts)");
			console.log("  2. restart the DSH shell: the quota panel appears in the bottom-right corner");
			console.log("  3. if Google is not reachable directly, pick a transport in the panel");
			console.log("");
			console.log("update later: run this again.   remove: node install.mjs --uninstall");
		}
	}
} finally {
	if (cleanup) cleanup();
}