# bridge

The process that turns Google's Cloud Code transport into an OpenAI-compatible endpoint, plus the egress shim that carries it over a network which blocks Google.

```
node bridge.js          # starts both: API on 8787, shim on 8789
AG_EGRESS=0 node bridge.js   # API only, direct connections
```

## Endpoints

| Route | What it answers | Auth |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI chat, streaming and not | bearer |
| `GET /v1/models` | Model list and aliases | bearer |
| `GET /limits` | Per-account quota, per model | loopback socket |
| `GET /accounts` | Stored accounts and their state | loopback socket |
| `GET /health` | Liveness only: `{ok, service, port}` | none |

The bearer is `Authorization: Bearer $AG_BRIDGE_SECRET` (default `local-bridge`, compared in constant time). Account reads are gated by the socket being loopback rather than by the token, so a local process can read them — that is what the overlay plugin does. CORS only echoes loopback origins, so a page in the same browser cannot read `/accounts` or spend your quota. Details in [../docs/security.md](../docs/security.md).

## Layout

| File | Responsibility |
| --- | --- |
| `bridge.js` | Supervisor: loads config, starts the shim if enabled, then the server |
| `server.js` | HTTP surface, auth, CORS, routing |
| `accounts.js` | Token store, refresh, rotation |
| `egress.js` | Channel router, smart-DNS resolution, watchdog |
| `egress-ctl.mjs` | CLI: `status`, `use`, `add`, `check`, `bench`, `race`, `on`, `off` |
| `dns-fix.js` | Fallback resolver for poisoned local DNS |
| `lib/` | Protocol translation, streaming, schemas, pacing |
| `lib/images.js` | Image routing and file output; the one place a provider swap happens |

One deliberate non-feature: the bridge never rewrites the conversation. System messages are joined in order, assistant text is passed through as it is generated, and a refusal is delivered like any other answer. The single exception is a turn the model leaves completely empty: the retry ladder then appends a short system line asking for the answer it forgot. Prompt engineering belongs to the client that writes the prompts.

## Message translation

`lib/messages.js` maps OpenAI roles to Cloud Code `contents`, including tool calls and tool results, and `lib/schema.js` maps JSON-Schema tool declarations to Google's `functionDeclarations` with `toolConfig` for `tool_choice`. Unknown keywords are dropped rather than forwarded — Google rejects fields it does not know — while `anyOf`/`oneOf`/`allOf` are flattened into an outer description so the model still sees the intent.

## Streaming

`lib/stream.js` reads the upstream SSE, unwraps the `{response: ...}` envelope, and emits OpenAI deltas. Text goes through `lib/pacer.js`, which spreads each upstream arrival over a few small deltas so the answer appears at a steady rate instead of in 25-token lumps; the queue always drains faster than upstream produces, so pacing costs no time.

`finish_reason` is `length` when the model hit `max_tokens`, `tool_calls` when a tool was called, `stop` otherwise.

## Images

A turn that asks for a picture — by naming an image model, or in words — is handled by `lib/images.js` instead of the text path: the request is re-pointed at `AG_IMAGE_MODEL`, tools are stripped, and the returned `inlineData` is written to `AG_IMAGE_DIR`. The client gets markdown pointing at the absolute path, plus an `images` array. `AG_IMAGE_AUTO=0` keeps the model-by-name route and drops the word route. Routing rules, the duplicate-frame handling and how to swap the backend are in [../docs/images.md](../docs/images.md).

## Egress

Channel selection, the resolve-cache, the 6-second CONNECT budget and the TLS-probing watchdog are documented in [../docs/channels.md](../docs/channels.md). The short version:

- `route` names the channel in use, `routeChain` is the fallback order.
- A channel is either a smart-DNS provider, `proxy`, or `direct`.
- The watchdog probes the live channel with a real TLS handshake every `AG_WATCHDOG_MS`; two failures move the route to the next channel that passes.
- `curl localhost:8789/watchdog` runs a probe now instead of waiting for the timer.

## Tests

```bash
npm test                  # unit + images + egress + integration
npm run test:unit         # translation, schemas, pacing — offline
npm run test:images       # intent routing and file output — offline
npm run test:egress       # channels, watchdog, config, the settings surface
npm run test:integration  # spawning server against a mock Cloud Code — offline
npm run test:proxy        # CONNECT through a local proxy, end to end — network
npm run smoke             # four live calls; needs the bridge running and real credentials
```

Unit, integration and the config half of the egress suite are offline: they use a mock upstream. The egress suite also opens real TLS connections to prove that a dead channel is told apart from a live one, so it needs outbound network.

## Limits worth knowing

- A rejected request is returned once: only `429` and `5xx` are retried, because retrying a 400 just burns time.
- A thought-only turn closes with `stop` and empty content; the bridge will not invent an answer.
- The account store is written atomically but without an explicit POSIX mode; `chmod 600` it yourself.