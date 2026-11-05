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

### From the panel

The panel is the intended front end: the mode row switches transport, and the sub-panel under
it edits the parts of the mode that need a value.

| Mode | What the panel shows | What a change writes |
| --- | --- | --- |
| DNS | one chip per channel plus `our chain`, and a field for your own resolver | `{mode:"dns", route}` or `{providers:{custom:{dns:[…]}}, route:"custom"}` |
| Proxy | proxy URL, fallback URL, remove | `{proxy, fallbackProxy, mode:"proxy"}` |
| VPN | whether a tunnel is up, and its name | `{mode:"vpn"}` |
| Direct | nothing to configure | `{mode:"direct"}` |

Every one of them is a single `POST /` against the shim, so the same change can be made with
`curl` or by hand in `~/.dsh/ag-egress.json`. The panel does not keep its own copy of the
state: it renders what the shim reports.

The proxy field is never prefilled with a masked value. `GET /` masks credentials
(`socks5://***:***@host:port`), and writing that string back would replace a working address
with bullets — so the field starts empty, and an empty field on save means "keep the saved
one".

### Subscribing instead of polling

`GET /events` is a `text/event-stream` carrying the same document as `GET /`, pushed when it
changes. The panel subscribes and stops asking; a state that did not change produces no frame,
so an idle panel costs nothing.

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

`direct` is never promoted, even when it probes healthy. It is not a relay with an address to
fail over from — it is the absence of one — so putting it at the head of the chain would make
the watchdog silently disable relaying.

A probe is only a success if the edge answers with a response. A finished TCP handshake and a
finished TLS handshake both happen on connections that then carry nothing, and a regional
refusal arrives *after* a successful handshake with a body that says so; both are failures here
(`REGION_BLOCK`). One sample is shared for 30 seconds (`AG_PROBE_TTL_MS`), so the watchdog,
`/bench` and `/watchdog` do not each pay for the same answer.

While a request is being routed, a channel that failed in the last two minutes
(`AG_FAILURE_MEMORY_MS`) is tried after the ones that carried traffic. Without that, a dead
first leg costs every request its connect timeout until the next watchdog beat.

When the machine changes networks — a non-internal IPv4 address appears or disappears — every
cached channel answer is dropped, because all of them were measured from somewhere else.

## Backwards compatibility

Files written before modes existed have no `mode` field. They are read as:

| File | Inferred mode |
| --- | --- |
| `enabled: false` | `direct` |
| `proxy` or `fallbackProxy` set | `proxy` |
| otherwise | `dns` |

Nothing is rewritten on disk: the file keeps whatever it has until something actually changes
the mode.