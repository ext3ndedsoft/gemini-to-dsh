# How it works

Technical background for [gemini-to-dsh](../README.en.md).

**Streaming that feels like typing, not loading.** Google sends ~25 tokens every ~300 ms; passed through as is, text lands in lumps. The bridge cuts each chunk into small deltas on an even beat (`30 ms`, `AG_PACE_MS`). Thinking goes out at once instead of waiting for the end of the turn.

**Honest errors.** A rejected request is returned once rather than hammered into the same wall three times — a retry only makes sense for `429` and `5xx`. `finish_reason` tells `length`, `tool_calls` and `stop` apart instead of always lying `stop`.

**Several accounts, switching by what is left.** Requests go through accounts sorted by the **five-hour window** — the one that ends a session. A pinned account gets priority, but only while it has more than 5% of its five-hour quota; at five percent it stops being first and the request goes where the window is fuller. That is the seamless switch — before the `429`, not after.

**An egress layer that survives the death of its channels.** Where Google is blocked, the bridge goes through smart-DNS relays: the resolver returns an edge address, TCP goes there, the SNI stays Google's, and the real certificate is verified to the end. Channels are tried as a chain, and every two minutes the watchdog probes the live channel with a **real response**, not just a handshake: a relay can accept TCP forever and never finish TLS, and that is exactly how one channel silently died for three hours. Two failures and the route moves to the next channel that passed the same probe.

## Egress modes

The switch in the panel changes how traffic leaves the machine:

| Mode | What the shim does |
| --- | --- |
| `DNS` | goes to the smart-DNS relay from `route` / `routeChain`, SNI and certificate stay Google's |
| `Proxy` | CONNECT to `proxy`, then to `fallbackProxy` |
| `VPN` | nothing: traffic already leaves through the tunnel, the shim only checks that it is up |
| `Direct` | nothing: no relays at all |

The mode is an explicit `mode` field in `~/.dsh/ag-egress.json`, not a consequence of which fields happen to be filled in. Old configs without `mode` are read by the same fields as before.

<details>
<summary><b>Rules that change behaviour</b></summary>

- **`direct` is never promoted by the watchdog.** It is not a relay but the absence of one: putting it at the head of the chain would silently turn the relays off.
- **A failed probe is not only a failed TCP connection.** If a reply with region text arrives after the handshake, the channel counts as dead: the transport is alive, the route is useless.
- **One probe serves everyone.** The watchdog, `/bench` and `/watchdog` share one 30-second measurement (`AG_PROBE_TTL_MS`) instead of paying three times.
- **A dead first leg does not slow requests.** A channel that failed in the last two minutes (`AG_FAILURE_MEMORY_MS`) moves behind the live ones in trial order — before the watchdog even blinks.
- **A network change drops the caches.** An external IPv4 appeared or vanished — every measurement was about a different network.

The proxy field accepts `host:port`, `http://user:pass@host:port`, `socks5://host:port` and `socks5h://` (remote DNS). A foreign scheme such as `ftp://` is rejected rather than read as HTTP: an address that "saved" but leads elsewhere is worse than an honest refusal. Under the field you see exactly what was understood, and "check" opens a tunnel without writing anything.

The panel does not poll the shim, it listens: `GET /events` returns the same document as `GET /` but as a stream, and a frame is sent only on change. An idle panel spends no requests.

</details>

Details, scripts and a "which mode fits my network" walkthrough: [docs/transports.md](docs/transports.md). On quotas: [docs/quotas.md](docs/quotas.md).

## Images

Any model in the harness can draw — in words, with no commands. "Draw a cat" goes to `gemini-3.1-flash-image` even when the profile has a text model: the bridge looks at the user's last message and, if it asks for something to be drawn, swaps in the right model itself.

The answer arrives as a file path: the picture lands in `~/.dsh/images/`, and `![generated image](path)` is put in the text for DSH to render. If the model stays silent there is still a "Generated an image." line — an empty answer is indistinguishable from a broken one.

What goes to drawing: a verb plus a subject ("draw a fox"), editing a finished picture (attach it and say "redraw it as a watercolour"). What does not: "what is in this picture", "describe the photo" — that is reading, and it stays with the ordinary model. Three knobs: `AG_IMAGE_MODEL`, `AG_IMAGE_DIR`, `AG_IMAGE_AUTO=0`. Details: [docs/images.md](docs/images.md).

## Honest limitations

- **Unofficial transport.** Cloud Code is not a public API; Google changes it without notice, and one day the bridge will need a patch. Your account, your risk, your subscription.
- **Speed is bounded by the model.** Measured on the raw stream: `gemini-3.8-flash` — 85–140 tokens/s (`-tiered` is steadily higher, ~140), `gemini-3-flash` — ~230. The route does not matter: four channels and direct give the same number. Counters in clients like DSH may show more — they also count thinking tokens and tool-call JSON.
- **On some plans `gemini-3.8-flash` exists only as `-tiered`**; the alias resolves this itself.
- **Thinking arrives in two big blocks,** so it cannot be smoothed without delaying the answer. Text is smooth, thinking comes in chunks.
- **Relays are someone else's infrastructure.** They see the SNI and the volume, but not the TLS content. And they die without warning.
- **The tooling leans Windows:** `start.cmd` and `install-autostart.ps1` are Windows, `start.sh` covers macOS/Linux, but autostart is not covered.
