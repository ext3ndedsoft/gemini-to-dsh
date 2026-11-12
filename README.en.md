<p align="center">
  <img src="assets/banner.en.svg?v=4" alt="gemini→dsh — Gemini in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/LICENSE-MIT-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/NODE-%E2%89%A520-7c6cff?style=for-the-badge&labelColor=0b0f17&logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/DEPENDENCIES-NONE-31d0aa?style=for-the-badge&labelColor=0b0f17" alt="No dependencies">
</p>

<p align="center"><a href="README.md">Русский</a> · <b>English</b></p>

**gemini-to-dsh** connects Gemini to [DSH](https://github.com/deepseek-ai/deepseek-harness) and to any client that speaks OpenAI. It is a small local bridge plus a panel in DSH that shows quota per account and switches how traffic leaves your machine when Google is not directly reachable.

No dependencies, Node 20+.

## What you get

- **Gemini in DSH** — streaming, tools, images, thinking.
- **Several accounts** — a request goes where the most quota is left, before a `429`.
- **Network egress** — `DNS`, `Proxy`, `VPN` or `Direct`; a watchdog routes around a dead channel on its own.
- **Quota panel** — the five-hour and weekly window of every account, and the egress switch.
- **Web search** and **lean-context** — optional, as separate plugins.

<p align="center">
  <img src="assets/panel-dns.png?v=4" alt="Panel: DNS mode" width="384">
  &nbsp;
  <img src="assets/panel-proxy.png?v=4" alt="Panel: Proxy mode" width="384">
</p>

## Install

You need Node 20+ and DSH started at least once (so a profile exists).

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
cd gemini-to-dsh
node install.mjs
```

Without a clone — download one file and it fetches the rest itself:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs -OutFile install.mjs; node install.mjs
```

```bash
# macOS / Linux
curl -fsSLO https://raw.githubusercontent.com/ext3ndedsoft/gemini-to-dsh/main/install.mjs && node install.mjs
```

The installer finds the DSH profile, puts the bridge into `~/.dsh/bridge` and the panel into the profile, adds it to `cordis.patch.yml` (a copy is saved as `.bak`), checks the syntax and tells you which credentials are still missing. To update, run it again; your `.env` and `ag-egress.json` are left alone.

```bash
node install.mjs --with web-search,lean-context   # plus the other plugins (or --all)
node install.mjs --dry-run                        # only show what would happen
node install.mjs --uninstall                      # remove plugins and profile entries
```

Then restart DSH: the panel appears in the bottom-right corner.

## Accounts

The bridge uses the OAuth tokens that a Google AI Pro subscription already created on the machine (Cloud Code access, not a free-tier key). Put them where the bridge expects them:

- `~/.gemini/oauth_creds.json` — the first account;
- `~/.gemini/dsh-bridge/accounts.json` — a rotation set (optional).

Point `AG_CREDS_FILE` and `AG_ACCOUNTS_FILE` elsewhere if you like. The OAuth client used to refresh the tokens is **not part of the repository**: set `AG_CLIENT_ID` and `AG_CLIENT_SECRET`, or put them in `~/.dsh/ag-oauth.json`.

## Connecting to DSH

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  config:
    provider: antigravity
    model: gemini-3.8-flash
    reasoningEffort: medium
```

The bridge listens on `127.0.0.1:8787` and accepts the bearer that matches `AG_BRIDGE_SECRET` (default `local-bridge`).

## If Google is not reachable directly

Nothing to do: the `DNS` channel chain is baked into the defaults, and every two minutes the watchdog probes the live channel with a real response and moves to the next one after two failures. Pick your own channel, a proxy or a VPN in the panel.

If Google is reachable directly you can switch the shim off with `AG_EGRESS=0` (Windows: `set "AG_EGRESS=0" && bridge\start.cmd`, otherwise `AG_EGRESS=0 ./start.sh`).

| Mode | What it does |
| --- | --- |
| `DNS` | goes through a smart-DNS relay, SNI and certificate stay Google's |
| `Proxy` | CONNECT via `host:port`, `http://`, `socks5://` or `socks5h://` |
| `VPN` | changes nothing, only checks that the tunnel is up |
| `Direct` | no relays |

## More

- [How it works](docs/how-it-works.md) — streaming, account rotation, watchdog, egress modes, images, limitations
- [Configuration and tests](docs/configuration.md) — every environment variable
- [Step-by-step install](docs/plugin-install.md), [transports](docs/transports.md), [quotas](docs/quotas.md), [images](docs/images.md), [security](docs/security.md)
- Plugins: [quota-overlay](plugins/quota-overlay/README.md) · [web-search](plugins/web-search/README.md) · [lean-context](plugins/lean-context/README.md)

## The honest short version

Cloud Code is an unofficial transport; Google can change it without notice. Relays are someone else's infrastructure: they see the SNI and the volume, not the TLS content. Speed is set by the model, not the route. Your account, your risk, your subscription. The rest is in the [limitations](docs/how-it-works.md#honest-limitations).

## License

MIT — see [LICENSE](LICENSE). The project is not affiliated with Google; Gemini and Antigravity belong to Google, and their code is not distributed here.