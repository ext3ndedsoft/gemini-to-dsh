<p align="center">
  <img src="assets/banner.en.svg?v=2" alt="gemini→dsh — Gemini in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-7c6cff?style=for-the-badge&labelColor=0b0f17&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="No dependencies">
</p>

<p align="center">
  <a href="README.md">Русский</a> · <b>English</b>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-panel">Panel</a> ·
  <a href="#egress-modes">Egress modes</a> ·
  <a href="#plugins">Plugins</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#honest-limitations">Limitations</a>
</p>

---

**gemini-to-dsh** is a bridge that brings Gemini into [DSH](https://github.com/deepseek-ai/deepseek-harness) and into any other client that speaks OpenAI. It ships with an egress layer for when Google is not directly reachable, a web-search plugin with a real cache, and a panel for quota and mode switching.

No dependencies. Node 20+. Two local ports.

```text
DSH / any OpenAI client
        │  POST /v1/chat/completions   (SSE)
        ▼
127.0.0.1:8787  bridge ── translates OpenAI ↔ Cloud Code, rotates accounts
        │  CONNECT tunnel
        ▼
127.0.0.1:8789  egress shim ── picks a channel, keeps the SNI
        │
        ▼
smart-DNS ──► Google Cloud Code ──► Gemini
```

## What's inside

| | |
| --- | --- |
| **Full OpenAI surface** | Streaming and plain replies, tools with `tool_choice`, images, `reasoning_content`, usage with the cached-prompt-token count |
| **Several accounts** | Requests follow the remaining five-hour window; the switch happens before a `429`, not after |
| **Egress layer** | `DNS` / `Proxy` / `VPN` / `Direct` channels; a watchdog probes a channel with a real response |
| **Panel in DSH** | Quota for both windows and egress control in one click |
| **Web search** | Keyed APIs → DuckDuckGo, cache, pacing, cooldown |
| **Images** | "Draw a cat" is routed to the image model on its own |

## Quick start

### One command

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

It installs the bridge into `~/.dsh/bridge`, the quota panel into the DSH profile, and appends the panel to `cordis.patch.yml` without touching what is already there. Running it again duplicates nothing. Only the credentials remain. Step by step, if you prefer to do it by hand: [docs/plugin-install.md](docs/plugin-install.md).

### Accounts

The bridge reuses the OAuth tokens that a Google AI Pro subscription already created on the machine (this is Cloud Code access, not a free-tier key). Put them where the bridge expects them — `~/.gemini/oauth_creds.json` for the first account and `~/.gemini/dsh-bridge/accounts.json` for the rotation set — or point `AG_CREDS_FILE` / `AG_ACCOUNTS_FILE` elsewhere. The OAuth client used to refresh those tokens is **not part of the repository**: set `AG_CLIENT_ID` and `AG_CLIENT_SECRET`, or put them in `~/.dsh/ag-oauth.json`.

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

Run without that variable. The default chain (`bezmezhau → geohideeu → geohide → magicdns → direct`) is baked into the defaults, so the first run works as is; channels die over time, which is what the watchdog is for. Add your own channel from the panel (`custom DNS`) or from a terminal:

```bash
cd bridge
node egress-ctl.mjs add mydns 203.0.113.10 203.0.113.11 --seeds=cloudaicompanion.googleapis.com
node egress-ctl.mjs use mydns
node egress-ctl.mjs check mydns
```

### Connecting to DSH

The provider points at the local port. A minimal profile patch:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

The bridge accepts any `Authorization` that matches `AG_BRIDGE_SECRET` (default `local-bridge`), so the provider entry needs exactly that bearer.

## The panel

<p align="center">
  <img src="assets/panel-dns.png?v=2" alt="Panel: DNS mode, channels and a custom chain" width="384">
  &nbsp;
  <img src="assets/panel-proxy.png?v=2" alt="Panel: Proxy mode, address and tunnel check" width="384">
</p>

The panel controls, it does not only display. The egress mode is switched right in it, and each mode expands what it needs: `DNS` shows a chip per channel, "our chain" and a field for your own resolver; `Proxy` shows the address (a URL, with credentials, or plain `host:port`), a fallback address and a "check" button that opens a tunnel and **saves nothing**. Every click is one `POST` to the shim; the panel keeps no state of its own and draws what the shim answered.

For each account both Google quotas are visible: the five-hour one and the **weekly** one — a ring with a percentage and a reset timer, separately per group ("Gemini Models", "Claude and GPT models").

## How it works

**Streaming that feels like typing, not loading.** Google sends ~25 tokens every ~300 ms; passed through as is, text lands in lumps. The bridge cuts each chunk into small deltas on an even beat (`30 ms`, `AG_PACE_MS`). Thinking goes out at once instead of waiting for the end of the turn.

**Honest errors.** A rejected request is returned once rather than hammered into the same wall three times — a retry only makes sense for `429` and `5xx`. `finish_reason` tells `length`, `tool_calls` and `stop` apart instead of always lying `stop`.

**Several accounts, switching by what is left.** Requests go through accounts sorted by the **five-hour window** — the one that ends a session. A pinned account gets priority, but only while it has more than 5% of its five-hour quota; at five percent it stops being first and the request goes where the window is fuller. That is the seamless switch — before the `429`, not after.

**An egress layer that survives the death of its channels.** Where Google is blocked, the bridge goes through smart-DNS relays: the resolver returns an edge address, TCP goes there, the SNI stays Google's, and the real certificate is verified to the end. Channels are tried as a chain, and every two minutes the watchdog probes the live channel with a **real response**, not just a handshake: a relay can accept TCP forever and never finish TLS, and that is exactly how one channel silently died for three hours. Two failures and the route moves to the next channel that passed the same probe.

## Egress modes

The switch in the panel changes how traffic leaves the machine:

| Mode | What the shim does |
| --- | --- |
| `DNS` | goes to the smart-DNS relay from `route` / `routeChain`, SNI and certificate stay Google's |
| `Proxy` | CONNECT to `proxy`, then to `fallbackProxy` |
| `VPN` | nothing: traffic already leaves through the tunnel, the shim only checks that it is up |
| `Direct` | nothing: no relays at all |

The mode is an explicit `mode` field in `~/.dsh/ag-egress.json`, not a consequence of which fields happen to be filled in. Old configs without `mode` are read by the same fields as before.

<details>
<summary><b>Rules that change behaviour</b></summary>

- **`direct` is never promoted by the watchdog.** It is not a relay but the absence of one: putting it at the head of the chain would silently turn the relays off.
- **A failed probe is not only a failed TCP connection.** If a reply with region text arrives after the handshake, the channel counts as dead: the transport is alive, the route is useless.
- **One probe serves everyone.** The watchdog, `/bench` and `/watchdog` share one 30-second measurement (`AG_PROBE_TTL_MS`) instead of paying three times.
- **A dead first leg does not slow requests.** A channel that failed in the last two minutes (`AG_FAILURE_MEMORY_MS`) moves behind the live ones in trial order — before the watchdog even blinks.
- **A network change drops the caches.** An external IPv4 appeared or vanished — every measurement was about a different network.

The proxy field accepts `host:port`, `http://user:pass@host:port`, `socks5://host:port` and `socks5h://` (remote DNS). A foreign scheme such as `ftp://` is rejected rather than read as HTTP: an address that "saved" but leads elsewhere is worse than an honest refusal. Under the field you see exactly what was understood, and "check" opens a tunnel without writing anything.

The panel does not poll the shim, it listens: `GET /events` returns the same document as `GET /` but as a stream, and a frame is sent only on change. An idle panel spends no requests.

</details>

Details, scripts and a "which mode fits my network" walkthrough: [docs/transports.md](docs/transports.md). On quotas: [docs/quotas.md](docs/quotas.md).

## Images

Any model in the harness can draw — in words, with no commands. "Draw a cat" goes to `gemini-3.1-flash-image` even when the profile has a text model: the bridge looks at the user's last message and, if it asks for something to be drawn, swaps in the right model itself.

The answer arrives as a file path: the picture lands in `~/.dsh/images/`, and `![generated image](path)` is put in the text for DSH to render. If the model stays silent there is still a "Generated an image." line — an empty answer is indistinguishable from a broken one.

What goes to drawing: a verb plus a subject ("draw a fox"), editing a finished picture (attach it and say "redraw it as a watercolour"). What does not: "what is in this picture", "describe the photo" — that is reading, and it stays with the ordinary model. Three knobs: `AG_IMAGE_MODEL`, `AG_IMAGE_DIR`, `AG_IMAGE_AUTO=0`. Details: [docs/images.md](docs/images.md).

## Plugins

| Plugin | What it does |
| --- | --- |
| [`quota-overlay`](plugins/quota-overlay/README.md) | Panel: accounts, weekly and five-hour quota, egress mode and its setup |
| [`web-search`](plugins/web-search/README.md) | The `web_search` provider: keyed APIs first (Serper, Tavily, Brave, Google CSE, Exa), DuckDuckGo last — behind a 10-minute cache, singleflight, a token bucket and a 90-second cooldown. The free path holds about 7–8 requests a minute |
| [`lean-context`](plugins/lean-context/README.md) | Replaces old tool results so long sessions do not drown in their own history |

`install.mjs` installs the first one. For the others, drop the folder into `~/.dsh/profiles/web/plugins/` and add a line to the profile patch:

```yaml
- insert:
    - id: web-search
      name: "./plugins/web-search/index.js"
```

## Configuration

Everything is environment variables; the full list with defaults is in [`.env.example`](.env.example). The main ones:

| Variable | Default | What it does |
| --- | --- | --- |
| `AG_BRIDGE_PORT` | `8787` | Port of the OpenAI-compatible API |
| `AG_BRIDGE_SECRET` | `local-bridge` | Bearer the bridge accepts |
| `AG_EGRESS` | `1` | `0` turns the shim off entirely |
| `AG_EGRESS_PORT` | `8789` | CONNECT shim port |
| `AG_EGRESS_FILE` | `~/.dsh/ag-egress.json` | Routing config; defaults are baked in |
| `AG_EGRESS_DNS_TTL` | `60000` | Resolver answer cache |
| `AG_EGRESS_BUDGET` | `6000` | Budget of one CONNECT across all channels |
| `AG_WATCHDOG_MS` | `120000` | Watchdog interval |
| `AG_PROBE_TTL_MS` | `30000` | How long one channel measurement lives |
| `AG_EXHAUSTED_AT` | `0.05` | Threshold at which a pin stops being first |
| `AG_PACE_MS` | `30` | Text emission beat; `AG_PACE=0` turns it off |
| `AG_IMAGE_MODEL` | `gemini-3.1-flash-image` | Which model draws pictures |
| `AG_UPSTREAM_TIMEOUT_MS` | `150000` | How long upstream may stay silent before the first byte |
| `AG_RESUME_ATTEMPTS` | `2` | How many times an answer cut mid-word is continued |
| `AG_HUB_VERSION` | `2.26.0` | Version of the `hub` identity below which Google withholds some quota groups |
| `AG_CLIENT_ID` / `AG_CLIENT_SECRET` | — | OAuth client for refreshing tokens |

## Tests

```bash
cd bridge
npm test            # unit + egress + modes + integration
npm run smoke       # four requests (models, text, tools, stream); needs a running bridge
```

The unit and integration suites are self-contained: they stand up a Cloud Code mock, so a failing test means code, not network. Egress is different — it opens real TLS connections to check that `probeChannel` tells a live channel from a dead one; it needs outbound network and will not pass in an isolated CI.

Panel preview for docs: `node preview/build-preview.mjs dns|proxy` builds HTML from the panel's real CSS.

## Honest limitations

- **Unofficial transport.** Cloud Code is not a public API; Google changes it without notice, and one day the bridge will need a patch. Your account, your risk, your subscription.
- **Speed is bounded by the model.** Measured on the raw stream: `gemini-3.8-flash` — 85–140 tokens/s (`-tiered` is steadily higher, ~140), `gemini-3-flash` — ~230. The route does not matter: four channels and direct give the same number. Counters in clients like DSH may show more — they also count thinking tokens and tool-call JSON.
- **On some plans `gemini-3.8-flash` exists only as `-tiered`**; the alias resolves this itself.
- **Thinking arrives in two big blocks,** so it cannot be smoothed without delaying the answer. Text is smooth, thinking comes in chunks.
- **Relays are someone else's infrastructure.** They see the SNI and the volume, but not the TLS content. And they die without warning.
- **The tooling leans Windows:** `start.cmd` and `install-autostart.ps1` are Windows, `start.sh` covers macOS/Linux, but autostart is not covered.

## License

MIT — see [LICENSE](LICENSE). The project is not affiliated with Google; Gemini and Antigravity belong to Google, and their code is not distributed here.