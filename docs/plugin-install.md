# Installing the quota panel

A guide for someone who is not me: from an empty machine to a working panel in the DSH shell.
No chat commands — everything is a button in the panel.

The panel is one plugin, `quota-overlay`. It needs two things already running: the bridge
(which talks to Google) and the egress shim (which gets the traffic out). The plugin starts both
on its own, so in practice you install a folder and edit one file.

---

## 0. What you need before starting

| | |
| --- | --- |
| **Node** | 20 or newer (`node -v`). No dependencies to install. |
| **DSH** | a shell where you can edit `~/.dsh/profiles/web/cordis.patch.yml` |
| **Google** | a subscription that carries Cloud Code (Google AI Pro and up), already signed in on this machine |
| **Network** | either direct access to Google, or a smart-DNS relay / proxy / VPN — see [transports](transports.md) |

If you are not sure about the last row: run the bridge first, see whether it answers, and only
then worry about transports.

---

## 1. Put the bridge where the plugin expects it

The plugin looks for `bridge.js` in `~/.dsh/bridge` (`AG_BRIDGE_DIR` overrides it).

```bash
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
mkdir -p ~/.dsh/bridge
cp -r gemini-to-dsh/bridge/. ~/.dsh/bridge/
```

Windows (PowerShell):

```powershell
git clone https://github.com/ext3ndedsoft/gemini-to-dsh.git
New-Item -ItemType Directory -Force "$HOME\.dsh\bridge" | Out-Null
Copy-Item "gemini-to-dsh\bridge\*" "$HOME\.dsh\bridge\" -Recurse -Force
```

That folder is the whole bridge: `bridge.js`, `server.js`, `egress.js`, `lib/`, `accounts.js`.
Nothing to `npm install`.

## 2. Give the bridge your Google credentials

The bridge reuses the OAuth tokens that your subscription already created — it does not ask for
a password and does not store one.

- first account: `~/.gemini/oauth_creds.json` (the file Antigravity or Gemini CLI leaves behind);
- several accounts to rotate: `~/.gemini/dsh-bridge/accounts.json`;
- other paths: `AG_CREDS_FILE` / `AG_ACCOUNTS_FILE`.

Refreshing those tokens needs an OAuth client, which is **not** shipped here. Put your own into
`~/.dsh/ag-oauth.json`:

```json
{ "clientId": "...", "clientSecret": "..." }
```

or export `AG_CLIENT_ID` / `AG_CLIENT_SECRET`. The bridge starts fine without it until a token
actually expires, then it will say so.

## 3. Pick a transport

If Google answers from your machine directly, skip this step entirely — the default chain will
fall through to `direct` on its own.

If it does not, open `~/.dsh/ag-egress.json` (it is created on first start) and choose a mode:

```json
{ "mode": "dns", "route": "geohide", "routeChain": ["geohide", "magicdns", "direct"] }
{ "mode": "proxy", "proxy": "socks5://127.0.0.1:1080" }
{ "mode": "vpn" }
```

Which one applies to you, and why, is in [transports.md](transports.md). The panel has the same
switch, so you can also just try them there once it is installed.

## 4. Install the plugin

```bash
mkdir -p ~/.dsh/profiles/web/plugins
cp -r gemini-to-dsh/plugins/quota-overlay ~/.dsh/profiles/web/plugins/
```

Then add the plugin to the profile. Open `~/.dsh/profiles/web/cordis.patch.yml` and put this
under the existing `- insert:` list (create the list if it is not there yet):

```yaml
- insert:
    - id: quota-overlay
      name: "./plugins/quota-overlay/index.js"
```

If the file already has an `- insert:` block, just add the two lines below it — YAML does not
like two `insert` keys in the same list item.

Restart the DSH shell. The panel appears as a small pill in the bottom-right corner; click it to
open.

## 5. Check that it works

Open the panel and look at the top:

- **a mode is highlighted**, and the line under it says what it is doing:
  `dagami › bezmezhau › direct` for DNS, an address for proxy, `tunnel is up` for VPN;
- **accounts show quotas** — a ring with the weekly percentage, a `5H` badge under it;
- **`test route`** in the footer sends one word to the model and reports back. It is the only
  honest end-to-end check: everything above can be green while Google refuses the region.

From the terminal, the same thing without the panel:

```bash
curl -s 127.0.0.1:8787/limits -H 'authorization: Bearer local-bridge' | head -c 400
curl -s 127.0.0.1:8789/ | grep -o '"mode"[^,]*'
```

## 6. If something is off

| Symptom | Cause | Fix |
| --- | --- | --- |
| pill says `offline` | bridge is not running | check `~/.dsh/bridge` exists and Node is 20+; the plugin spawns `bridge.js` itself and logs why it failed |
| accounts are empty | no credentials found | step 2 — the file must exist and be readable |
| `no accounts` and `bridge 500` | token expired, no OAuth client | step 2, `~/.dsh/ag-oauth.json` |
| mode says `proxy url is not set` | `mode: "proxy"` without an address | set a proxy or switch mode |
| everything is green but requests fail | transport is wrong for your network | try `direct`, then a relay, then `proxy` — one at a time |
| weekly rings are missing, five-hour works | Google did not return groups for that account | nothing to fix; the per-model numbers still work |

## 7. What it talks to

Two local ports, both bound to loopback:

- `8787` — OpenAI-compatible API, bearer `local-bridge` (`AG_BRIDGE_SECRET` changes it);
- `8789` — the egress shim, plus the state and switch the panel reads.

Neither is exposed to the network. The panel speaks to them from your browser, which is why it
keeps working on a phone while the computer is on — the page is served by the same machine.