# Egress config — field by field

- **enabled** — master switch for the local CONNECT shim; `false` turns all routing off.
- **route** — the channel tried first for Google traffic.
- **routeChain** — channels attempted in order until one connects: `bezmezhau`, `geohideeu`, `geohide`, `magicdns`, then `direct`.
- **allow** — host patterns permitted onto the upstream route; everything else connects straight.
- **fallback** — what to do when the chain is exhausted; `direct` means a plain connection.
- **connectTimeout** — TCP connect timeout for one channel attempt, in ms. The whole walk still has to fit `AG_EGRESS_BUDGET`.
- **providers** — smart-DNS channels; `dns` lists resolver IPs that hand back an edge address.
- **seeds** — names the resolver *does* answer for, used when the real target is not in its zone: the shim resolves a seed, connects there, and the relay routes by SNI.

Install: copy this file to `~/.dsh/ag-egress.json`, or to whatever `AG_EGRESS_FILE` names.
Disable: set `"enabled": false` here, or start the bridge with `AG_EGRESS=0`.

Only hosts matching `allow` use these channels — all other traffic is left alone.