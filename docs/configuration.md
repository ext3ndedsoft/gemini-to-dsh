# Configuration and tests

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
