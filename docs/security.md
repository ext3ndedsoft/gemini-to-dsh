# Security

The bridge is a local tool that holds live Google credentials and spends real quota. This page states what it protects, what it deliberately does not, and what to do before publishing a fork. It describes the code as it is, not as it should be. See [channels.md](channels.md) for how traffic leaves the machine.

## Threat model

The bridge binds `AG_BRIDGE_HOST`, default `127.0.0.1`, port `AG_BRIDGE_PORT` (default `8787`). It opens no external interface unless that variable is changed. Loopback is a boundary between machines, not between programs: in a browser, loopback is every tab, and a page served from anywhere can issue requests to `127.0.0.1:8787`. That is the threat the code defends against.

## CORS is restricted on purpose

Every response is CORS-enabled, because the dashboard runs on a different local port. Reflecting any origin would let an unrelated page read `/accounts` — the e-mail addresses of the linked Google accounts — and drive `/v1/chat/completions` on the operator's quota. The rule in `server.js`:

- no `Origin` header: `access-control-allow-origin: *`. Not a browser, so CORS does not apply.
- a loopback origin (`127.0.0.1`, `localhost`, `[::1]`, any port): the origin is echoed back.
- anything else: no allow-origin header at all, and the refusal is logged. The request still runs server-side; the browser refuses to hand the response to the page.

Worth being precise about what this buys: CORS stops a page from *reading* a response and from sending credentialed cross-site requests that need a preflight. It is not authentication. A `text/plain` POST is a "simple request" and reaches the server without a preflight, which is why the account routes do not rely on CORS at all — they check the socket peer instead, and the quota-spending route needs the bearer, which a cross-site page cannot set without triggering a preflight.

Account routes (`/limits`, `/accounts`, `/accounts/*`) additionally require a loopback socket peer (`isLocal`), otherwise `403 local access only`. `/oauth/callback` is unauthenticated by design, since it is reached by a browser redirect from Google. `/health` is unauthenticated and returns only the service name and port.

## Bridge token

`/v1/*` requires `Authorization: Bearer <secret>`. The secret is `AG_BRIDGE_SECRET`, defaulting to `local-bridge`, compared with `crypto.timingSafeEqual`. State the limit plainly: this keeps accidental requests and misconfigured clients out. It does not stop a local process with the same user rights — that process reads the environment, the config, and the credential files directly.

```powershell
$env:AG_BRIDGE_SECRET = '<long random string>'
```

## Account tokens

The account pool lives in `AG_ACCOUNTS_FILE`, defaulting to `dsh-bridge/accounts.json` inside the directory that holds the credentials file — with the credentials at `~/.gemini/oauth_creds.json` (`AG_CREDS_FILE`), that is `~/.gemini/dsh-bridge/accounts.json`. Moving one moves the other. The file holds refresh tokens: never commit it, never back it up to a public place, never paste it into an issue.

The bridge writes it atomically (temp file, then rename) but sets no explicit POSIX mode, so it inherits the process umask. Restrict it yourself:

```bash
chmod 600 ~/.gemini/dsh-bridge/accounts.json ~/.gemini/oauth_creds.json
```

On Windows, restrict the ACL of the same files to the current user instead.

## OAuth client

The source carries no client credentials. The refresh client is read from `AG_CLIENT_ID` and `AG_CLIENT_SECRET`, or from `~/.dsh/ag-oauth.json` (`AG_OAUTH_FILE`) as `{"client_id": "...", "client_secret": "..."}`. The lookup happens when a refresh is first needed, so the server starts either way and a missing client surfaces as an explicit configuration error on the first token refresh (or on login), not at boot.

This is deliberate: it is a public installed-application client, not a project credential, and a copy of it in source is what turns a fork into a free relay for strangers. Keeping it outside the tree also means rotating it needs no code change.

## What the bridge does not do

- It does not decrypt, inspect, or re-encrypt channel traffic. TLS terminates at the bridge against Google's real name; a smart-DNS relay sees SNI and volume only.
- It does not proxy anything but the hosts in `allow` (default `*.googleapis.com`, `googleapis.com`), decided per connection, not per process.
- It does not listen on external interfaces under default settings.

Two honest exceptions. The egress shim on `127.0.0.1:8789` carries no token, and that port can reroute traffic, so everything beyond a plain `GET /` is closed to browsers on its own terms rather than by CORS. State changes need `Content-Type: application/json`, and any non-loopback `Origin` is refused before the body is parsed. Requiring JSON is the part that matters — it forces a preflight, which a foreign origin does not get.

Only `GET /` is read-only: it returns masked routing config and counters. `GET /watchdog` runs a probe immediately and can therefore move the route, and `GET /bench` opens real connections — both take the same origin check as a write, and `/bench` additionally refuses any host outside the `allow` list, so it cannot be turned into a probe of arbitrary or internal addresses. A caller with no `Origin` header at all (the CLI, `curl`) is treated as a local process and allowed, because it can reach the file and the port directly anyway.

The same rule covers the account mutations on `8787` (`/accounts/pin`, `/accounts/enabled`, `/accounts/remove`): they are guarded by the loopback socket *and* by the JSON-content-type check, because "loopback" includes every tab in the operator's browser. Reads of `/accounts` and `/limits` remain socket-gated only, which is what lets a local overlay show them.

## Before publishing a fork

- Search the tree for secrets and read every hit:

```powershell
Get-ChildItem -Recurse -File -Exclude *.log |
  Select-String -Pattern 'client_secret|AG_CLIENT_SECRET|refresh_token|access_token|Bearer [A-Za-z0-9]'
```

- Check docs, scripts, and comments for personal data and absolute home paths.
- Confirm the bundled `.gitignore` still covers your local state — it ships with rules for `*.log`, `.env`, `accounts.json`, `ag-oauth.json`, `search.json` and the egress config — and that nothing you added slips past them:

```gitignore
.env
*.log
bridge.log
accounts.json
ag-oauth.json
```

- Revoke and rotate: remove the OAuth grant for the client in the Google account, rotate the client secret, set a new `AG_BRIDGE_SECRET`, and unlink and re-add the pooled accounts so tokens from the old file are worthless.

## Honest limitation

Smart-DNS relays see the hostname and the size of every connection routed through them, even though the content is encrypted. If that metadata is unacceptable in your setting, do not use channels: set `AG_EGRESS=0` or `"enabled": false` and run direct.