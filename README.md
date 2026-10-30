# gemini-to-dsh

[![Release](https://img.shields.io/github/v/release/ext3ndedsoft/gemini-to-dsh?color=blue)](https://github.com/ext3ndedsoft/gemini-to-dsh/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](bridge/package.json)

An OpenAI-compatible bridge that puts **Gemini 3.x Flash** inside [DSH](https://github.com/deepseek-ai/deepseek-harness) — or any other OpenAI-speaking client — including a region-agnostic egress layer for networks where Google is not directly reachable, a web-search plugin with real caching, and a quota overlay.

No dependencies. Node 20+. Two loopback ports.

```text
DSH / any OpenAI client
        │  POST /v1/chat/completions   (SSE)
        ▼
127.0.0.1:8787  bridge ── translates OpenAI ↔ Cloud Code, rotates accounts
        │  CONNECT tunnel
        ▼
127.0.0.1:8789  egress shim ── picks a channel, keeps SNI intact
        │
        ▼
smart-DNS relay edge ──► Google Cloud Code ──► Gemini
```

## Why this exists

Gemini's Antigravity model is not exposed as an ordinary public API. It is served through Google's Cloud Code transport, which speaks a different protocol, uses its own OAuth flow, and resolves to hostnames that are blocked outright in some countries. DSH, meanwhile, speaks OpenAI.

This project is the missing adapter, plus everything needed to keep that adapter alive on a hostile network: a channel router with a watchdog, a quota view across several accounts, and a search tool that does not fall over after three queries.

## What you actually get

**A real OpenAI surface, not a thin proxy.**
Streaming and non-streaming, tools with `tool_choice` (`auto` / `none` / `required` / specific function), image parts, `reasoning_content` for thinking, and a usage block that reports cached prompt tokens — the number that tells you whether the prompt cache is working at all.

**Streaming that looks like typing, not like loading.**
Upstream hands over ~25 tokens every ~300 ms. Passing those through renders an answer in lumps, so the bridge re-cuts each arrival into small deltas at a steady cadence (`30 ms`, `AG_PACE_MS`). Reasoning is emitted the instant it arrives instead of being held until the end of the turn.

**Honest failure semantics.**
A rejected request is returned once, not retried three times into the same wall — only `429` and `5xx` are worth a second attempt, so only those are retried. `finish_reason` distinguishes `length` (truncated), `tool_calls`, and `stop` instead of always claiming `stop`.

**Effort mapping that behaves monotonically.**
`reasoning_effort` maps to Google's thinking budget, measured: minimal → 0 reasoning tokens, medium → ~220, high → ~300–550. Note the interaction with `max_tokens`: with a small ceiling every level collapses, because the thinking budget reserves its own headroom first.

**Several accounts, one endpoint.**
Requests rotate across the accounts you have stored; `/accounts` and `/limits` show the e-mails and the per-model quota left. One dead account does not take the bridge down.

**An egress layer that survives its own channels dying.**
Where Google is blocked, the bridge connects through smart-DNS relays: the resolver hands out a relay edge, TCP goes there, the SNI stays Google's, and the real certificate is verified end to end. Channels are tried in a chain, and a watchdog probes the live channel with an actual TLS handshake every two minutes — because a relay can accept TCP forever and never complete TLS, which is exactly how one died silently for three hours. Two failed probes switch the route to the next channel that passes the same probe. Probes are bounded at 6 seconds so a dead resolver cannot stretch the verdict into a minute and a half. **Requests never wait for the watchdog**: it has its own socket and its own timer.

**Web search that does not get throttled into uselessness.**
A DSH plugin that registers a `web_search` provider: keyed APIs (Serper, Tavily, Brave, Google CSE, Exa) first, DuckDuckGo behind them, ScraperAPI's Google endpoint as the paid last resort — all behind a 10-minute cache, single-flight, a token bucket, a challenge detector and a 90-second cooldown. The free path settles around 7-8 queries a minute (a burst of two, then one per eight seconds); the plugin is built around that ceiling instead of pretending it is not there.

**A quota overlay and a context trimmer.**
Two small plugins: a sidebar panel with per-account quota, and a `lean-context` pass that replaces old tool results with a marker so long sessions do not drown in their own history.

## Quick start

### If Google is reachable from your network

```bash
git clone https://github.com/<you>/gemini-to-dsh.git
cd gemini-to-dsh
AG_EGRESS=0 ./start.sh          # macOS / Linux
# or: set "AG_EGRESS=0" && bridge\start.cmd     (Windows)
```

`AG_EGRESS=0` skips the shim entirely — no extra hop, no channel config, nothing to tune.

### If it is not

Run without that variable. The default channel chain (`bezmezhau → geohideeu → geohide → magicdns → direct`) is compiled in, so the first run works as-is; channels die over time, which is what the watchdog is for. See [docs/channels.md](docs/channels.md) for adding your own:

```bash
cd bridge
node egress-ctl.mjs add mydns 203.0.113.10 203.0.113.11 --seeds=cloudaicompanion.googleapis.com
node egress-ctl.mjs use mydns
node egress-ctl.mjs check mydns
```

### Accounts

The bridge reuses the OAuth tokens that a Google AI Pro subscription already produced on the machine (Cloud Code entitlement, not a free-tier key). Store them where the bridge expects them — `~/.gemini/oauth_creds.json` for the first account, `~/.gemini/dsh-bridge/accounts.json` for the rotation set — or point `AG_CREDS_FILE` / `AG_ACCOUNTS_FILE` somewhere else. The OAuth client needed to refresh those tokens is **not** part of this repository: set `AG_CLIENT_ID` and `AG_CLIENT_SECRET`, or put them in `~/.dsh/ag-oauth.json`.

```bash
cd bridge && node bridge.js
curl -s localhost:8787/limits -H 'authorization: Bearer local-bridge' | head
```

## Wiring it into DSH

Point a provider at the loopback port. Minimal profile patch:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

The bridge accepts any `Authorization` value that matches `AG_BRIDGE_SECRET` (default `local-bridge`), so the provider entry just needs that bearer.

## Configuration

Everything is env-first; the [`.env.example`](.env.example) lists every variable the bridge itself reads, with its default in a comment. (The plugins read a few of their own — `AG_BRIDGE_URL`, `AG_EGRESS_URL`, `WARP_CLI` — documented in each plugin's README.) The ones that matter most:

| Variable | Default | What it does |
| --- | --- | --- |
| `AG_BRIDGE_PORT` | `8787` | OpenAI-compatible port |
| `AG_BRIDGE_SECRET` | `local-bridge` | Bearer token the bridge accepts |
| `AG_EGRESS` | `1` | `0` disables the shim completely |
| `AG_EGRESS_PORT` | `8789` | CONNECT shim port |
| `AG_EGRESS_FILE` | `~/.dsh/ag-egress.json` | Routing config; defaults are compiled in |
| `AG_EGRESS_DNS_TTL` | `60000` | Resolver answer cache |
| `AG_EGRESS_BUDGET` | `6000` | Total budget for one CONNECT, all channels |
| `AG_WATCHDOG_MS` | `120000` | Watchdog interval |
| `AG_PACE_MS` | `30` | Text drip cadence; `AG_PACE=0` disables |
| `AG_CLIENT_ID` / `AG_CLIENT_SECRET` | — | OAuth client for token refresh |
| `DSH_SEARCH_CONFIG` | `~/.dsh/search.json` | Keys for the search plugin |

## Plugins

| Plugin | What it does |
| --- | --- |
| [`web-search`](plugins/web-search/README.md) | `web_search` provider: keyed APIs → DuckDuckGo, cached and paced |
| [`quota-overlay`](plugins/quota-overlay/README.md) | Sidebar panel: accounts, per-model quota, egress route |
| [`lean-context`](plugins/lean-context/README.md) | Replaces old tool results so long sessions stay cheap |

Install by dropping the folder into `~/.dsh/profiles/web/plugins/` and adding one line to the profile patch:

```yaml
- insert:
    - id: web-search
      name: "./plugins/web-search/index.js"
```

## Testing

```bash
cd bridge
npm test            # unit + egress + integration
npm run smoke       # four calls (models, text, tools, stream); needs the bridge running
```

The unit and integration suites are self-contained: they spin up a mock Cloud Code server, so a failing test means code, not network. The egress suite is different by nature — it opens real TLS connections to verify that `probeChannel` distinguishes a working channel from a dead one, so it needs outbound network and will not run in an air-gapped CI.

## Honest limitations

- **Unofficial transport.** Cloud Code is not a public API; Google changes it without notice and one day this bridge will need a patch. Your account, your risk, your subscription.
- **Throughput is model-bound.** `gemini-3.8-flash` decodes at ~85–100 tokens/s regardless of route — four channels and a direct fallback, the same number on each. `gemini-3-flash` is roughly 2.5× faster; the bottleneck is the model, not the network.
- **`gemini-3.8-flash` may only exist as the `-tiered` variant** on some plans; the alias resolves it for you.
- **Reasoning arrives in two large blocks** upstream, so it cannot be paced without delaying the answer. Text is smooth; thinking is chunky.
- **Egress relays are somebody else's infrastructure.** They see SNI and volume, never TLS content. They also die without warning.
- **Windows-first tooling**: `start.cmd` and `install-autostart.ps1` are Windows; `start.sh` covers macOS/Linux, but the autostart path does not.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Google; Gemini and Antigravity are Google's, and this project ships none of their code.