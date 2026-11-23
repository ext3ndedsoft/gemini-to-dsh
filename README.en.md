<p align="center">
  <img src="assets/banner.en.png?v=9" alt="gemini-to-dsh — Gemini and Google Search inside DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-0a0a0a?style=for-the-badge&labelColor=ffffff" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-ffffff?style=for-the-badge&labelColor=0a0a0a&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-0a0a0a?style=for-the-badge&labelColor=ffffff" alt="No dependencies">
</p>

<p align="center"><a href="README.md">Русский</a> · <b>English</b></p>

**gemini-to-dsh** brings Gemini (3.x / 4) and live Google Search to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and any OpenAI-compatible client. It is a zero-dependency local bridge on Node.js paired with a compact overlay panel inside DSH.

## What you get

- **Full Gemini support in DSH** — smooth paced streaming, native tool calling, image generation, thinking (`reasoning_effort`), automatic continuation on cut streams, and KV-cache keep-alive for long sessions.
- **Smart account rotation** — tracks both 5-hour and weekly quota windows per account and shifts traffic before hitting `429`.
- **Live Google Search grounding** — `/v1/search` and the `web-search` plugin return a grounded summary plus resolved source URLs; you can pick the default search model right from the panel.
- **Scoped network egress** — `DNS`, `Proxy`, `VPN`, or `Direct`. Only `*.googleapis.com` traffic uses the selected route; everything else on your machine stays untouched.
- **Corner overlay panel** — shows per-window and per-model quotas, response latency, active egress route, and the `web-search` model selector.

<p align="center">
  <img src="assets/panel-dns.png?v=9" alt="Quota and egress panel: DNS mode" width="360">
  &nbsp;&nbsp;
  <img src="assets/panel-proxy.png?v=9" alt="Quota and egress panel: Proxy mode" width="360">
</p>

## Quick install

Requires **Node.js 20+** and DSH started at least once (so a profile directory exists).

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

Or install in one command without cloning manually:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs -OutFile install.mjs; node install.mjs
```

```bash
# macOS / Linux
curl -fsSLO https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs && node install.mjs
```

The installer locates your DSH profile, copies the bridge to `~/.dsh/bridge`, installs the overlay plugin, and adds it to `cordis.patch.yml` (saving a `.bak` backup). Re-running it updates the code while leaving your `.env` and `ag-egress.json` intact.

```bash
node install.mjs --with web-search,lean-context   # include web search and context pruning (or --all)
node install.mjs --dry-run                        # preview changes without writing anything
node install.mjs --uninstall                      # remove plugins and profile entries
```

Restart DSH afterwards — the quota pill will appear in the bottom-right corner.

## Accounts & OAuth

The bridge reuses the OAuth session from your Google AI Pro subscription (Cloud Code access, not a free-tier API key):

- `~/.gemini/oauth_creds.json` — primary account (picked up automatically if you signed in via Antigravity or Gemini CLI);
- `~/.gemini/dsh-bridge/accounts.json` — optional pool of extra accounts for rotation (you can add more via `+ аккаунт` in the panel).

Override paths with `AG_CREDS_FILE` and `AG_ACCOUNTS_FILE`. The OAuth client credentials used to refresh tokens are **not shipped in this repository** — set `AG_CLIENT_ID` and `AG_CLIENT_SECRET` or place them in `~/.dsh/ag-oauth.json`.

## Connecting to DSH

Add the provider to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

To route DSH's `web_search` tool through the bridge's Google Search grounding, add to `~/.dsh/search.json`:

```json
{
  "order": ["antigravity"],
  "providers": {
    "antigravity": { "baseUrl": "http://127.0.0.1:8787", "key": "local-bridge" }
  }
}
```

The bridge binds to loopback `127.0.0.1:8787` only and checks the bearer token against `AG_BRIDGE_SECRET` (default `local-bridge`).

## If Google is not reachable directly

No manual setup is needed: a `DNS` relay chain is enabled by default, and a background watchdog probes the active channel every two minutes with a real request, switching automatically after two failures. You can switch modes or configure a custom proxy directly in the panel.

If Google is directly reachable from your network, disable the shim with `AG_EGRESS=0` (Windows: `set "AG_EGRESS=0" && bridge\start.cmd`, macOS/Linux: `AG_EGRESS=0 ./start.sh`).

| Mode | What it does |
| --- | --- |
| `DNS` | Routes only `*.googleapis.com` through a smart-DNS relay while verifying Google's real TLS certificate end-to-end |
| `Proxy` | Connects via your `http://`, `socks5://`, or `socks5h://` proxy |
| `VPN` | Leaves routing untouched and only monitors whether your system VPN tunnel is up |
| `Direct` | Direct connection with no relays or proxies |

## Documentation

- [How it works](docs/how-it-works.md) — streaming, account rotation, watchdog, egress modes, images, limitations
- [Configuration and tests](docs/configuration.md) — all environment variables and test commands
- [Manual install](docs/plugin-install.md) · [Transports](docs/transports.md) · [Quotas](docs/quotas.md) · [Images](docs/images.md) · [Security](docs/security.md)
- Plugins: [quota-overlay](plugins/quota-overlay/README.md) · [web-search](plugins/web-search/README.md) · [lean-context](plugins/lean-context/README.md)

## Good to know

Cloud Code is an unofficial transport and Google may change it without notice. Public smart-DNS relays see the target hostname (SNI) and traffic volume, never the encrypted TLS payload. Generation speed is bounded by the model itself, not the route. Your account, your risk, your subscription — see [limitations](docs/how-it-works.md#honest-limitations).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Google; Gemini and Antigravity belong to Google, and none of their code is distributed here.
