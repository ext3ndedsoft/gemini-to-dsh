<p align="center">
  <img src="assets/banner.svg" alt="Gemini — inside DeepSeek Harness" width="900">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-7c6cff?style=for-the-badge&labelColor=0b0f17&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="No dependencies">
</p>

<p align="center">
  <a href="README.md">Русский</a> · <b>English</b>
</p>

A bridge that puts **Gemini 3.x Flash** inside [DSH](https://github.com/deepseek-ai/deepseek-harness) — or any client that speaks OpenAI. It ships with an egress layer for networks where Google is blocked, a web-search plugin with a real cache, and a panel for quotas and transport.

No dependencies, Node 20+, two loopback ports.

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

<p align="center">
  <img src="assets/panel-dns.png" alt="Panel: DNS mode with channels and chain" width="384">
  <img src="assets/panel-proxy.png" alt="Panel: Proxy mode with address and tunnel check" width="384">
</p>

## Why this exists

The Antigravity model is not offered through the public API. It lives inside Cloud Code: a different protocol, its own OAuth, hosts that some countries block outright. DSH, meanwhile, speaks OpenAI.

This is that adapter, plus everything needed to keep it alive on a hostile network: channel routing with a watchdog, quotas across several accounts, and search that does not die on the third request.

## What it actually gives you

**The whole OpenAI surface, not a thin proxy.**
Streaming and plain replies, tools with `tool_choice` (`auto` / `none` / `required` / a named function), images, `reasoning_content`, and a usage block that reports cached prompt tokens — so you can see whether caching works at all.

**Streaming that reads like typing, not like a download.**
Google hands over ~25 tokens every ~300 ms; passed through as-is, text arrives in slabs. The bridge splits each chunk into small deltas with an even beat (`30 ms`, `AG_PACE_MS`). Reasoning is forwarded immediately instead of being held back until the end.

**Honest errors.**
A refused request comes back once instead of being hammered three times against the same wall — retrying only makes sense for `429` and `5xx`. `finish_reason` distinguishes `length`, `tool_calls` and `stop` instead of always claiming `stop`.

**Several accounts, switched by what is left.**
Requests go to accounts ordered by the **five-hour window** — the one that ends a session. A pinned account keeps priority only while it has more than 5% of that window left: at five percent it stops being first and the request goes where the window is fuller. That is the seamless switch, made before the `429` rather than after it.

**An egress layer that survives its own channels.**
Where Google is blocked, the bridge goes through smart-DNS relays: the resolver returns an edge address, TCP goes there, SNI stays Google's, and the real certificate is verified end to end. Channels are tried in a chain, and every two minutes the watchdog probes the live one with **a real response**, not just a handshake: a relay happily accepts TCP forever and never finishes TLS, and that is exactly how one channel died silently for three hours. Two failures and the route moves to the next channel that passed the same probe.

**A panel that controls, not merely displays.**
The transport is switched from the panel, and each mode reveals what it needs: `DNS` shows a chip per channel, the chain chip and a field for your own resolver; `Proxy` shows the address (a link, with credentials, or just `host:port`), a fallback and a `check` button that opens a tunnel and **saves nothing**. Every click is one `POST` to the shim; the panel keeps no state of its own and renders what the shim answered.

**Web search that is not throttled into uselessness.**
A DSH plugin registering a `web_search` provider: keyed APIs first (Serper, Tavily, Brave, Google CSE, Exa), DuckDuckGo last — behind a 10-minute cache, a single-flight guard, a token bucket, a challenge detector and a 90-second cooldown. The free path holds about 7–8 requests per minute.

**Quotas in two windows.**
Per account the panel shows both Google quotas: the five-hour and the **weekly** one — a ring with a percentage and a reset timer, per group ("Gemini Models", "Claude and GPT models"). Plus `lean-context`, which trims old tool results so long sessions do not drown in their own history.

## Quick start

### One command

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

Installs the bridge into `~/.dsh/bridge`, the quota panel into the DSH profile, and appends it to `cordis.patch.yml` without touching what is already there. Re-running duplicates nothing. Only credentials are left. Step by step, if you prefer doing it by hand: [docs/plugin-install.md](docs/plugin-install.md).

### Accounts

The bridge reuses the OAuth tokens your Google AI Pro subscription already created on the machine (that is Cloud Code access, not a free-tier key). Put them where the bridge expects them — `~/.gemini/oauth_creds.json` for the first account and `~/.gemini/dsh-bridge/accounts.json` for a rotation set — or point `AG_CREDS_FILE` / `AG_ACCOUNTS_FILE` elsewhere. The OAuth client used to refresh them is **not** in this repository: set `AG_CLIENT_ID` and `AG_CLIENT_SECRET`, or keep them in `~/.dsh/ag-oauth.json`.

```bash
cd bridge && node bridge.js
curl -s localhost:8787/limits -H 'authorization: Bearer local-bridge' | head
```

### If Google is reachable directly

```bash
AG_EGRESS=0 ./start.sh          # macOS / Linux
# or: set "AG_EGRESS=0" && bridge\start.cmd     (Windows)
```

`AG_EGRESS=0` does not start the shim at all — no extra hop, no channel setup.

### If it is not

Start without that variable. The default chain (`bezmezhau → geohideeu → geohide → magicdns → direct`) is baked into the defaults, so the first run works as is; channels die over time, which is what the watchdog is for. Add your own from the panel (`свой DNS`) or from a terminal:

```bash
cd bridge
node egress-ctl.mjs add mydns 203.0.113.10 203.0.113.11 --seeds=cloudaicompanion.googleapis.com
node egress-ctl.mjs use mydns
node egress-ctl.mjs check mydns
```

## Connecting to DSH

The provider points at the local port. Minimal profile patch:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

The bridge accepts any `Authorization` equal to `AG_BRIDGE_SECRET` (default `local-bridge`), so the provider entry needs exactly that bearer.

## Transport modes

The panel switch changes how traffic leaves the machine:

| Mode | What the shim does |
| --- | --- |
| `DNS` | goes to a smart-DNS relay from `route` / `routeChain`, Google SNI and certificate |
| `Proxy` | CONNECT through `proxy`, then `fallbackProxy` |
| `VPN` | nothing: traffic already leaves through the tunnel, the shim only verifies it is up |
| `Direct` | nothing: no relays at all |

The mode is an explicit `mode` field in `~/.dsh/ag-egress.json`, not a side effect of whichever fields happen to be set. Older files without a mode are read from the same fields as before.

A few rules worth knowing, because they change behaviour:

- **`direct` is never promoted by the watchdog.** It is not a relay but the absence of one: putting it at the head of the chain silently disables relaying.
- **A failed probe is not only a failed TCP connect.** If the answer after the handshake is a regional refusal, the channel counts as dead: the transport works, the route is useless.
- **One probe serves everybody.** The watchdog, `/bench` and `/watchdog` share a sample for 30 seconds (`AG_PROBE_TTL_MS`) instead of paying three times.
- **A dead first leg does not slow requests down.** A channel that failed in the last two minutes (`AG_FAILURE_MEMORY_MS`) is tried after the live ones — before the next watchdog beat.
- **A network change drops the caches.** An external IPv4 appears or disappears, and every measurement was about a different network.

The proxy field accepts `host:port`, `http://user:pass@host:port`, `socks5://host:port` and `socks5h://` (remote DNS). A foreign scheme such as `ftp://` is refused rather than read as HTTP: an address that "saved" but goes elsewhere is worse than a clear refusal. Under the field you can see what was understood, and `check` opens a tunnel without writing anything.

The panel does not poll the shim, it listens: `GET /events` streams the same document as `GET /`, and a frame is sent only when something changed. An idle panel costs nothing.

Details, scripts and "which mode fits my network" — [docs/transports.md](docs/transports.md). Quotas — [docs/quotas.md](docs/quotas.md).

## Images

Any model in the harness can draw — in words, no commands. "Draw a cat" goes to `gemini-3.1-flash-image` even when the profile names a text model: the bridge looks at the last user message and, if it asks for a picture, substitutes the right model itself.

The answer arrives as a file path: the image lands in `~/.dsh/images/` and the text gets `![generated image](path)`, which DSH renders. If the model stayed silent you still get "Generated an image." — an empty reply is indistinguishable from a broken one.

What routes to drawing: a verb plus a subject ("draw a cat", "generate an image of a sunset"), or editing an attached picture ("repaint this in watercolor"). What does not: "what is in this picture", "describe the photo" — that is reading, and it stays with the ordinary model. Three knobs: `AG_IMAGE_MODEL`, `AG_IMAGE_DIR`, `AG_IMAGE_AUTO=0`. Details — [docs/images.md](docs/images.md).

## Configuration

Everything is environment variables; the full list with defaults is in [`.env.example`](.env.example). The main ones:

| Variable | Default | What it does |
| --- | --- | --- |
| `AG_BRIDGE_PORT` | `8787` | OpenAI-compatible API port |
| `AG_BRIDGE_SECRET` | `local-bridge` | Bearer the bridge accepts |
| `AG_EGRESS` | `1` | `0` disables the shim entirely |
| `AG_EGRESS_PORT` | `8789` | CONNECT shim port |
| `AG_EGRESS_FILE` | `~/.dsh/ag-egress.json` | Routing config; defaults are baked in |
| `AG_EGRESS_DNS_TTL` | `60000` | Resolver answer cache |
| `AG_EGRESS_BUDGET` | `6000` | Budget for one CONNECT across all channels |
| `AG_WATCHDOG_MS` | `120000` | Watchdog interval |
| `AG_PROBE_TTL_MS` | `30000` | How long one channel sample lives |
| `AG_EXHAUSTED_AT` | `0.05` | Threshold where the pin stops being first |
| `AG_PACE_MS` | `30` | Text pacing; `AG_PACE=0` disables |
| `AG_IMAGE_MODEL` | `gemini-3.1-flash-image` | Model that draws |
| `AG_UPSTREAM_TIMEOUT_MS` | `150000` | How long upstream may stay silent before the first byte |
| `AG_RESUME_ATTEMPTS` | `2` | How many times a cut answer is continued |
| `AG_HUB_VERSION` | `2.26.0` | `hub` identity version, below which Google withholds some quota groups |
| `AG_CLIENT_ID` / `AG_CLIENT_SECRET` | — | OAuth client for token refresh |

## Plugins

| Plugin | What it does |
| --- | --- |
| [`quota-overlay`](plugins/quota-overlay/README.md) | Panel: accounts, weekly and five-hour quotas, transport mode and its settings |
| [`web-search`](plugins/web-search/README.md) | `web_search` provider: keyed APIs → DuckDuckGo, with cache and pacing |
| [`lean-context`](plugins/lean-context/README.md) | Replaces old tool results so sessions stay cheap |

`install.mjs` sets up the first one. For the rest, drop the folder into `~/.dsh/profiles/web/plugins/` and add a line to the profile patch:

```yaml
- insert:
    - id: web-search
      name: "./plugins/web-search/index.js"
```

## Tests

```bash
cd bridge
npm test            # unit + egress + modes + integration
npm run smoke       # four requests (models, text, tools, stream); needs a running bridge
```

The unit and integration suites are self-contained: they start a mock Cloud Code, so a failing test means code, not network. Egress is different — it opens real TLS connections to check that `probeChannel` tells a live channel from a dead one, so it needs outbound network and will not pass in an isolated CI.

## Honest limits

- **Unofficial transport.** Cloud Code is not a public API; Google changes it without notice, and one day the bridge will need a patch. Your account, your risk, your subscription.
- **Speed is the model's.** Measured on the raw stream: `gemini-3.8-flash` 85–140 tokens/s (`-tiered` is consistently higher, ~140), `gemini-3-flash` ~230. The route does not matter: four channels and direct give the same number. Client counters like DSH's may show more — they include reasoning tokens and tool-call JSON.
- **`gemini-3.8-flash` exists only as `-tiered` on some plans**; the alias resolves that itself.
- **Reasoning arrives in two large blocks**, so it cannot be smoothed without delaying the answer. Text is smooth, thinking is chunky.
- **Relays are someone else's infrastructure.** They see SNI and volume, not TLS content. And they die without notice.
- **The tooling leans Windows**: `start.cmd` and `install-autostart.ps1` are Windows; `start.sh` covers macOS/Linux, but autostart does not.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Google; Gemini and Antigravity belong to Google, none of their code is distributed here.