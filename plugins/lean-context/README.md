# dsh-plugin-lean-context

Keeps long DSH sessions small. On every step boundary, tool results from turns older
than `keepTurns` are replaced on the session surface with `[old tool result cleared]`,
using the same surface-replace protocol as the bundled tool-result pruner.

The durable session log keeps every original result — only what is *sent to the model*
changes. The current and previous turn, user messages, model answers and results of
tools listed in `keepTools` stay untouched.

Sessions are tracked from `session/event`, because the session handed over by
`agent/pre-step` is not always the one carrying the history.

## Config

    - insert:
        - id: lean-context
          name: "./plugins/lean-context/index.js"
          config: { keepTurns: 2, keepTools: ["skill"] }

- `keepTurns` (default `2`) — how many recent user turns are left intact. `1` saves
  more and causes more re-reads; `3` keeps more context.
- `keepTools` (default `["skill"]`) — tool names whose results are never trimmed.

Profile patches are read at boot, so restart the harness after adding the entry.

## Notes

- `LEAN_CONTEXT_PROBE=1` writes one line per hook call to `probe.log` next to the
  plugin. Off by default — it is a synchronous write in the hot path.
- `ctx.tokenMeter` is looked up dynamically: the plugin prunes with or without it.

## Tests

    node test.mjs

Offline, fake session and context, no DSH or server needed.