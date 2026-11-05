# Transports: DNS, proxy, VPN, direct

The shim on `127.0.0.1:8789` decides how a connection to Google leaves the machine. There are
four ways to do that, and the mode is an explicit setting rather than a side effect of whichever
fields happen to be filled in.

```json
// ~/.dsh/ag-egress.json
{
  "mode": "dns",
  "route": "geohide",
  "routeChain": ["geohide", "magicdns", "direct"],
  "proxy": "",
  "fallbackProxy": ""
}
```

| `mode` | What the shim does | What it ignores |
| --- | --- | --- |
| `dns` | Connects to a smart-DNS relay from `route` / `routeChain`, keeping SNI and the real certificate | `proxy`, `fallbackProxy` |
| `proxy` | Speaks CONNECT to `proxy`, then `fallbackProxy` | `route`, `routeChain` |
| `vpn` | Nothing: the traffic leaves through a tunnel you run | everything else |
| `direct` | Nothing: no relaying at all | everything else |

`vpn` and `direct` produce the same connection. They differ in intent and in what the panel
reports: `vpn` checks whether a tunnel is actually up and says so, `direct` does not pretend.
Keep one of them only if you know why — everything else is a relay choice.

## Choosing a mode

- **`dns`** — the default and the one that survives a blocked region. Smart-DNS relays route by
  SNI, so the shim still validates Google's own certificate; nothing is decrypted in between.
  Relays are somebody else's infrastructure: they see the name and the volume, not the content,
  and they die without notice. The chain and the watchdog exist for exactly that.
- **`proxy`** — you already have a proxy (WARP in proxy mode, a SOCKS5 on your LAN, a provider's
  endpoint). One address, optional fallback, no channel juggling.
- **`vpn`** — a system tunnel is up (WireGuard, OpenVPN, Tailscale, anything with a TUN/TAP
  adapter). Nothing to configure here, and WARP is not involved: it is used elsewhere, for the
  search plugin, as a plain local proxy.
- **`direct`** — no relay. Right when Google is reachable on its own, wrong everywhere else.

## Switching at runtime

```bash
# read the current state
curl -s 127.0.0.1:8789/ | jq '{mode, modeInfo, vpn, chain}'

# switch
curl -s -X POST 127.0.0.1:8789/ -H 'content-type: application/json' -d '{"mode":"proxy"}'
```

The answer is the full state, the same shape `GET /` returns. `modeInfo` is what the panel
shows: a label, a `ready` flag and one line of detail —

```json
"modeInfo": { "mode": "proxy", "label": "Proxy", "ready": true, "detail": "socks5://***@127.0.0.1:1080" }
```

Impossible combinations are rejected instead of silently degrading:

```bash
curl -s -X POST 127.0.0.1:8789/ -H 'content-type: application/json' -d '{"mode":"proxy"}'
# {"ok":false,"error":"mode \"proxy\" needs a proxy url"}
```

## VPN detection

`mode: "vpn"` reports `vpn: { connected, name, kind, interfaces }`. Detection looks at adapters
that are up and matches their description against WireGuard, OpenVPN, TAP-Windows, Wintun,
Tailscale, NordLynx, Proton, Mullvad and similar names, then prefers the one that carries the
default route. Refreshed every 15 seconds in the background (`AG_VPN_REFRESH_MS`), cached, and
never on the request path — a missing or slow PowerShell cannot delay a completion.

This is a report, not a control. The shim never starts, stops or reconfigures a VPN.

## Watchdog

The watchdog probes the active channel and, after two consecutive failures, promotes the first
healthy candidate from the chain. In `proxy` mode it probes the proxy. In `vpn` and `direct` it
does nothing at all: a tunnel or the operating system is not something the shim can fix by
switching channels, and a "fix" there would quietly undo the user's choice.

## Backwards compatibility

Files written before modes existed have no `mode` field. They are read as:

| File | Inferred mode |
| --- | --- |
| `enabled: false` | `direct` |
| `proxy` or `fallbackProxy` set | `proxy` |
| otherwise | `dns` |

Nothing is rewritten on disk: the file keeps whatever it has until something actually changes
the mode.