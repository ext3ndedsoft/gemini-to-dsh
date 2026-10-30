# Channels

A channel is the route that carries Gemini traffic out of a machine where Google refuses it. It changes the address a connection is sent to, for a fixed set of hosts. It is not a VPN: no interface is created, no routing table entry is touched, the system proxy is left alone, and no other process on the machine is affected. See [security.md](security.md) for what a channel operator can and cannot see.

## Why a channel is needed

Google rejects Cloud Code requests from some regions with `User location is not supported for the API use`. That decision is made on the other side, from the address the connection arrives from. Only a different exit address changes the answer.

The bridge needs that exit for one set of names, not for the whole machine. So `bridge.js` starts a small CONNECT shim on loopback and points the bridge child process at it. The shim reads the target host of every connection and routes only what is in `allow` (default `*.googleapis.com`, `googleapis.com`); everything else connects directly.

```text
client -> bridge.js -> server.js --CONNECT--> shim 127.0.0.1:8789 --> channel --> Google
                                             \-- other hosts ------> direct
```

## How a smart-DNS channel works

1. The bridge asks the channel's resolver for an A record of the real target name, for example `daily-cloudcode-pa.googleapis.com`.
2. The resolver answers with the address of a relay that forwards by hostname, not with Google's address.
3. TCP is opened to that relay address on port 443.
4. TLS is performed by the bridge itself, with the real SNI and verification on (`servername` set, `rejectUnauthorized: true`).
5. The relay reads the name from the handshake and forwards the stream to Google. It holds no certificate for the name and never terminates TLS.

The connection is therefore encrypted end to end between the machine and Google. The relay sees which name is contacted and how many bytes pass, and nothing else. A relay that answered with its own certificate would fail verification, and the sample would be marked dead rather than fast.

## Seeds

Some resolvers only answer for the names they proxy. MagicDNS is the example in the default config: it does not resolve `daily-cloudcode-pa.googleapis.com`. A `seeds` entry is the fallback: when the direct resolve fails, the shim resolves a seed name (default `cloudaicompanion.googleapis.com`) and connects to the address it gets back, still with the real SNI. Because the relay routes by SNI, an address learned from a seed carries any other Google name, and the certificate is still validated against the real name.

## Channel types

A **smart-DNS provider** is a resolver plus a relay, configured as `dns` (resolver addresses) and optional `seeds`. **`proxy`** is an HTTP `CONNECT` proxy, or SOCKS5/SOCKS5h, set through `proxy` and `fallbackProxy` as `http://`, `https://`, `socks5://` or `socks5h://`; credentials in the URL are supported and masked in logs and status. **`direct`** is no substitution, the last step of every chain.

## Routing policy

`route` is the channel tried first, `routeChain` is the ordered list tried after it. Unknown names are dropped; `direct` is appended when `fallback` is `direct`. One CONNECT walks the chain in order under a shared deadline (`AG_EGRESS_BUDGET`, 6000 ms by default, because the client gives up on its own connect timeout first). Each attempt gets `min(connectTimeout, time left)`; with less than 250 ms left the walk stops and the client receives `502 Bad Gateway`. `direct` is a normal entry in the chain, not a terminator: if the plain socket refuses, the walk moves on to whatever channel follows it — which is how the watchdog leaves `live > direct > dead` after a switch.

## The watchdog

A relay can die while still accepting TCP — the socket opens and TLS never completes. That is invisible to the request path, because TLS happens above the tunnel. The watchdog runs outside the request path, on its own timer (`AG_WATCHDOG_MS`, 120000 ms). Each tick performs one probe of the current route against `AG_WATCHDOG_HOST` (default `daily-cloudcode-pa.googleapis.com`): DNS, TCP, then a verified TLS handshake, all under a hard deadline so a dead resolver cannot stretch one verdict into a minute.

- One failed probe: the counter increments and nothing changes.
- Two failures in a row (`threshold = 2`): every remaining channel in the chain is probed with the same test, and the first candidate that passes becomes the route. `routeChain` is rewritten so the winner is first and the dead channel lands after `direct`.
- The dead channel's cached answers and remembered edge are dropped; if no candidate passes, the route is left alone and a line is written to the log.

Changing `route` by hand resets the counter. `GET /watchdog` runs one pass on demand and returns `route`, `failures`, `lastProbeAt`, `lastSwitchAt`, `lastError`, `switches`, `intervalMs` — failure count, last probe time, last switch time, last error, total switches, timer interval. It is not a read-only endpoint: the pass may move the route.

`GET /bench?host=…&rounds=…` times every channel end to end. It opens real connections, so it is restricted to the `allow` list (a host outside it gets `400`) and, like `/watchdog`, refuses callers whose `Origin` is not loopback. A process without an `Origin` header — the CLI, `curl` — is allowed.

## Channels at time of writing

**Snapshot taken on 2026-10-30.** Channel state is not a property of the code; relays are operated by third parties and change without notice. Re-measure with `check all` before trusting this table.

| channel | type | state at time of writing | notes |
|---|---|---|---|
| `bezmezhau` | smart-DNS | works | passes the TLS probe and carried real completions in the last measurement |
| `geohideeu` | smart-DNS | works | GeoHide resolver reached by its European addresses |
| `geohide` | smart-DNS | broken: TLS fails | the relay accepts TCP, the handshake does not complete |
| `magicdns` | smart-DNS | edge accepts TCP, no TLS answer | needs `seeds`; its resolver does not answer `daily-cloudcode-pa.googleapis.com` |
| `direct` | direct | unusable where Google is blocked | the connection is reset, or it lands and the API answers with the region rejection |

## Adding a channel

```powershell
node egress-ctl.mjs add myrelay 203.0.113.10 203.0.113.11 --seeds=cloudaicompanion.googleapis.com
node egress-ctl.mjs use myrelay
node egress-ctl.mjs check myrelay
```

`add` takes a name, one or more resolver addresses, and an optional seed name (default `cloudaicompanion.googleapis.com`); it merges the channel into `providers` and prints the channel list. `use` sets `route` and enables routing — next connection, no restart. `check` pins the channel, waits for the shim config cache and the keep-alive pool to expire, then sends real completions through it.

## Checking a channel

```powershell
node egress-ctl.mjs status            # route, chain, per-channel counters, connection stats
node egress-ctl.mjs check all         # real completions through every channel
node egress-ctl.mjs race              # same completion pinned per channel, timed end to end
curl http://127.0.0.1:8789/watchdog   # run one watchdog pass now
```

`check` prints one row per channel:

- `ok` — successful runs out of attempted runs; zero means no answer at all.
- `ttfb` — milliseconds from request to first token, the latency felt before text starts.
- `t/s` — completion tokens per second after the first token. A channel can win the handshake and still stream badly, so this is the number that decides.
- `note` — the error, or a marker that the failure coincided with a region-rejection wave, in which case the control channel was retested and failed too.

## Do I even need this?

If Google is reachable directly, no. Two switch-offs, same effect:

```powershell
$env:AG_EGRESS = '0'    # or set "enabled": false in the egress config file
```

With either, `bridge.js` does not start the shim at all: it logs `egress disabled: connecting directly, no shim`, removes `HTTP_PROXY`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY` from the child environment, and starts the bridge directly. No extra hop, no local listener. If the shim fails to start, the launcher logs it and starts direct rather than refusing to run.

`node egress-ctl.mjs off` is the runtime equivalent: the shim keeps running but sends every host direct, which is useful for comparison without a restart.

## Limits and trust

Third-party resolvers and relays are someone else's infrastructure. They see the SNI of the connections routed through them, and the volume and timing of those connections. They do not see request or response bodies, prompts, tool arguments, or account tokens. They can also disappear any day, which is why there is a chain rather than a single channel, and why the watchdog exists. Treat a working channel as a temporary measurement, not a guarantee.

## Tuning

| variable | default | effect |
|---|---|---|
| `AG_EGRESS_DNS_TTL` | `60000` | how long a resolver answer is reused, per channel and host |
| `AG_EGRESS_BUDGET` | `6000` | total milliseconds one CONNECT may spend walking the chain |
| `AG_WATCHDOG_MS` | `120000` | watchdog interval |
| `AG_WATCHDOG_HOST` | `daily-cloudcode-pa.googleapis.com` | host the probe samples |
| `connectTimeout` | `15000` | per-attempt TCP timeout from the config file, capped by the remaining budget |