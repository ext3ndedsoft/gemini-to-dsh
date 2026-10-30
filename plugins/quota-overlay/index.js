/**
 * Host half of the Antigravity quota plugin.
 *
 * Registers a human-facing `/limits` command over the local bridge and exposes
 * the browser bundle (`./client`) that draws the same numbers in the shell
 * overlay. The bridge is the only source of truth: it owns the account pool and
 * the per-account quota from Cloud Code.
 */

import { superviseBridge } from "./supervisor.js";

// `ctx.config.bridgeUrl` / `ctx.config.egressUrl` win; then the environment; then loopback.
const DEFAULT_BRIDGE = "http://127.0.0.1:8787";
const DEFAULT_EGRESS = "http://127.0.0.1:8789";
let BRIDGE = process.env.AG_BRIDGE_URL || DEFAULT_BRIDGE;
let EGRESS = process.env.AG_EGRESS_URL || DEFAULT_EGRESS;

export const name = "ag-limits";
export const inject = ["commands"];

async function egressState() {
	const res = await fetch(`${EGRESS}/`, { cache: "no-store", signal: AbortSignal.timeout(6000) });
	if (!res.ok) throw new Error(`egress shim answered ${res.status}`);
	return res.json();
}

async function egressSet(patch) {
	const res = await fetch(`${EGRESS}/`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
		signal: AbortSignal.timeout(10000)
	});
	const json = await res.json();
	if (!res.ok) throw new Error(json.error || `egress shim answered ${res.status}`);
	return json;
}

/** Real end-to-end check: one tiny completion through the live route. */
async function bridgePing() {
	const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// "local-bridge" is a compatibility default, not a secret. Set
			// AG_BRIDGE_SECRET to a real token before the bridge leaves loopback.
			authorization: `Bearer ${process.env.AG_BRIDGE_SECRET || "local-bridge"}`
		},
		body: JSON.stringify({
			model: "gemini-3.8-flash",
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 8,
			stream: false
		}),
		signal: AbortSignal.timeout(120000)
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, ok: res.ok, json };
}

function renderEgress(state) {
	const config = state.config || {};
	const stats = state.stats || {};
	const lines = [
		`route      ${config.route || (config.proxy ? "proxy" : "direct")}`,
		`relay      ${config.relay || "off"}`,
		`scoped to  ${(config.allow || []).join(", ")}`,
		`fallback   ${config.fallback || "direct"}`,
		"",
		`connections  proxied ${stats.proxied || 0} · direct ${stats.direct || 0} · failed ${stats.failed || 0}`,
		`last         ${stats.lastRoute || "-"} → ${stats.lastHost || "-"}`
	];
	if (stats.lastError) lines.push(`last error   ${stats.lastError}`);
	return lines.join("\n");
}

function renderPing(ping) {
	if (ping.ok) return "route works — the model answered";
	const message = ping.json && ping.json.error ? ping.json.error.message : `HTTP ${ping.status}`;
	if (/location is not supported/i.test(message)) {
		return `still geoblocked from this egress: ${message}`;
	}
	return `failed: ${message}`;
}

async function fetchLimits(force) {
	const res = await fetch(BRIDGE + "/limits" + (force ? "?force=1" : ""), {
		cache: "no-store",
		signal: AbortSignal.timeout(30_000)
	});
	if (!res.ok) throw new Error(`bridge answered ${res.status}`);
	return res.json();
}

function clockOf(iso) {
	if (!iso) return "";
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render(report) {
	const accounts = report.accounts || [];
	if (!accounts.length) return "No Antigravity accounts configured. Add one from the quota widget.";
	const blocks = accounts.map((account) => {
		const head = [account.email || account.id, account.tierName, account.project].filter(Boolean).join(" · ");
		if (!account.ok) return `${head}\n  unavailable: ${account.error || "unknown error"}`;
		const rows = Object.entries(account.models || {})
			.sort((left, right) => left[1].fraction - right[1].fraction)
			.map(([id, value]) => {
				const pct = String(Math.round((value.fraction || 0) * 100)).padStart(3);
				const reset = clockOf(value.resetTime);
				return `  ${id.padEnd(26)} ${pct}%${reset ? `   resets ${reset}` : ""}`;
			});
		const flags = [account.pinned ? "pinned" : null, account.native ? "antigravity session" : null]
			.filter(Boolean)
			.join(", ");
		return `${head}${flags ? `  [${flags}]` : ""}${rows.length ? "\n" + rows.join("\n") : "\n  no quota reported"}`;
	});
	const cooling = (report.cooldowns || []).map((entry) => {
		const minutes = Math.max(1, Math.round((entry.until - Date.now()) / 60000));
		return `${entry.account} / ${entry.model} — ${minutes}m`;
	});
	const tail = cooling.length ? `\n\ncooling down: ${cooling.join("; ")}` : "";
	return blocks.join("\n\n") + tail;
}

export function apply(ctx, pluginConfig = {}) {
	// The plugin config reaches `apply` as the second argument in DSH; `ctx.config` is
	// honoured too because the client half receives it that way.
	let config = pluginConfig ?? {};
	try {
		if (ctx.config) config = ctx.config;
	} catch {
		/* ctx.config is optional */
	}
	if (typeof config.bridgeUrl === "string" && config.bridgeUrl) BRIDGE = config.bridgeUrl;
	if (typeof config.egressUrl === "string" && config.egressUrl) EGRESS = config.egressUrl;
	ctx.effect(function* () {
		// DSH owns the bridge lifetime: started on boot, restarted if it dies,
		// stopped when this plugin is disposed.
		yield superviseBridge((message) => console.log(`[ag-limits] ${message}`));
		yield ctx.commands.register({
			definitionId: "dsh-plugin-ag-limits",
			name: "limits",
			description: "Antigravity account quota, per model",
			handler: async (invocation) => {
				const force = invocation.rawInput.trim().split(/\s+/).includes("--refresh");
				try {
					return { kind: "success", text: render(await fetchLimits(force)) };
				} catch (error) {
					return {
						kind: "error",
						text: `Antigravity bridge unreachable at ${BRIDGE}: ${error.message}`
					};
				}
			}
		});
		yield ctx.commands.register({
			definitionId: "dsh-plugin-ag-egress",
			name: "ag",
			description: "Gemini egress: /ag, /ag proxy <url>, /ag off, /ag test",
			handler: async (invocation) => {
				const input = invocation.rawInput.trim();
				const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
				const argument = rest.join(" ");
				try {
					if (!verb || verb === "status" || verb === "show") {
						return { kind: "success", text: renderEgress(await egressState()) };
					}
					if (verb === "proxy" || verb === "set") {
						if (!argument) return { kind: "error", text: "usage: /ag proxy socks5://127.0.0.1:1080" };
						const state = await egressSet({ proxy: argument, enabled: true });
						const ping = await bridgePing().catch((error) => ({ ok: false, status: 0, json: { error: { message: error.message } } }));
						return { kind: "success", text: `${renderEgress(state)}\n\n${renderPing(ping)}` };
					}
					if (verb === "off" || verb === "direct") {
						const state = await egressSet({ enabled: false, relay: "" });
						return { kind: "success", text: `${renderEgress(state)}\n\negress off: connecting directly` };
					}
					if (verb === "relay") {
						if (!argument) return { kind: "error", text: "usage: /ag relay https://<worker>.workers.dev  (or /ag relay off)" };
						const next = argument === "off" ? "" : argument;
						const state = await egressSet({ relay: next });
						const ping = next
							? await bridgePing().catch((error) => ({ ok: false, status: 0, json: { error: { message: error.message } } }))
							: null;
						return { kind: "success", text: `${renderEgress(state)}${ping ? "\n\n" + renderPing(ping) : ""}` };
					}
					if (verb === "test" || verb === "ping") {
						const [state, ping] = await Promise.all([
							egressState().catch(() => null),
							bridgePing().catch((error) => ({ ok: false, status: 0, json: { error: { message: error.message } } }))
						]);
						const head = state ? renderEgress(state) + "\n\n" : "";
						return { kind: ping.ok ? "success" : "error", text: head + renderPing(ping) };
					}
					return { kind: "error", text: `unknown: ${verb} — try /ag, /ag proxy <url>, /ag off, /ag test` };
				} catch (error) {
					return { kind: "error", text: `egress settings unreachable at ${EGRESS}: ${error.message}` };
				}
			}
		});
	}, "ag-limits lifecycle");
}