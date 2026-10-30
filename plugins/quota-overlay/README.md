# dsh-plugin-quota-overlay

Quota badge for the DSH shell overlay. It reads per-account, per-model remaining quota
from a local quota bridge over HTTP, draws it in a corner of the shell, and exposes:
- `/limits` — text report of accounts, models and cooldowns (`--refresh` forces a fetch).
- `/ag` — egress control: `/ag`, `/ag proxy <url>`, `/ag relay <url>`, `/ag off`, `/ag test`.

The plugin supervises the bridge: it adopts a healthy instance, spawns `bridge.js` from
the bridge directory if none answers, restarts it with backoff, stops it on dispose.

## Requirements
- Node 20+ (global `fetch`).
- A bridge serving `GET /limits`; an egress shim (`GET /`, `POST /`) for the route panel.
- Cloudflare WARP only to revive a local proxy tunnel.

## Env
- `AG_BRIDGE_DIR` — `~/.dsh/bridge`, the folder holding `bridge.js`.
- `AG_BRIDGE_URL` — `http://127.0.0.1:8787`, bridge base URL.
- `AG_EGRESS_URL` — `http://127.0.0.1:8789`, egress shim base URL.
- `AG_BRIDGE_SECRET` — `local-bridge`, the bridge token; **change it**.
- `AG_EGRESS_FILE` — `~/.dsh/ag-egress.json`, proxy config read by the supervisor.
- `WARP_CLI` — `warp-cli`, resolved through `PATH`.

## Profile
    - insert:
        - id: quota-overlay
          name: "./plugins/quota-overlay/index.js"
          config: { bridgeUrl: "http://127.0.0.1:8787", egressUrl: "http://127.0.0.1:8789", bridgeSecret: "local-bridge" }

Profile config wins over the environment for all three values. `local-bridge` is a
compatibility default for a loopback-only bridge, not a secret — set `bridgeSecret`
(and the bridge's `AG_BRIDGE_SECRET`) to something real if the port is reachable from
anything but this machine. The `/ag off` command disables the shim's routing rather
than clearing the proxy field, so the panel and the traffic agree afterwards.

## Tests
No test file: it needs a live bridge. `node --check index.js`, then `/limits` in a
profile with the bridge up.