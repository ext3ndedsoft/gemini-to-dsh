// lean-context for DeepSeek Harness — keep long sessions small.
//
// Same idea as an editor-side plugin: only the context sent to the model shrinks.
// Only what is SENT to the model changes; the durable session log keeps every original
// tool result.
//
// Window: tool results that sit BEFORE the keepTurns-th last user message are replaced
// on the session surface with a short marker — the same surface-replace protocol the
// bundled tool-result pruner uses, so replay and tool-call/result pairing stay intact.
// Answers, the commands, user messages, the kept turns and `skill` results stay put.
//
// Sessions are tracked from `session/event` because the session handed over by
// `agent/pre-step` is not always the one carrying the history (it can be empty).

import { appendFileSync } from "node:fs";

const MARKER = "[old tool result cleared]";
const MAX_TRACKED_SESSIONS = 16;

// Diagnostic trace next to the plugin: one short line per hook call.
// Off unless LEAN_CONTEXT_PROBE=1 — it is a synchronous write in the hot path.
const PROBE_ON = process.env.LEAN_CONTEXT_PROBE === "1";
const PROBE = new URL("./probe.log", import.meta.url);
let probeWrites = 0;
function probe(line) {
  if (!PROBE_ON || probeWrites > 600) return;
  probeWrites += 1;
  try {
    appendFileSync(PROBE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* the probe is optional */
  }
}

export const name = "lean-context";

/**
 * @param {any} ctx - cordis context with logger, optional tokenMeter.
 * @param {{ keepTurns?: number, keepTools?: string[] }} [config]
 */
export function apply(ctx, config = {}) {
  const keepTurns =
    Number.isInteger(config.keepTurns) && config.keepTurns > 0 ? config.keepTurns : 2;
  const keepTools = new Set(
    Array.isArray(config.keepTools) ? config.keepTools : ["skill"],
  );
  probe(`apply pid=${process.pid} keepTurns=${keepTurns}`);

  // Live sessions, newest last: the pre-step payload alone is not trustworthy.
  const sessions = new Map();
  const remember = (session) => {
    const key = session?.id;
    if (key === undefined || key === null) return;
    sessions.delete(key);
    sessions.set(key, session);
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  };

  ctx.on(
    "session/event",
    (session) => {
      if (session?.surface !== undefined) remember(session);
    },
    { global: true },
  );

  ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      if (!payload?.signal?.aborted) {
        const targets = new Set(sessions.values());
        if (payload?.agent?.session !== undefined) targets.add(payload.agent.session);
        const report = [];
        let cleared = 0;
        for (const session of targets) {
          try {
            const stats = clearOldResults(ctx, session, keepTurns, keepTools);
            cleared += stats.count;
            report.push(
              `${String(session.id ?? "?").slice(0, 8)}:n${stats.nodes}/u${stats.users}/r${stats.results}/c${stats.count}`,
            );
          } catch (error) {
            report.push(`err:${error instanceof Error ? error.message : String(error)}`);
          }
        }
        probe(`pre-step sessions=${targets.size} ${report.join(" ")}`);
        if (cleared > 0) ctx.logger.info(`lean-context: cleared ${cleared} old tool result(s)`);
      }
      return next();
    },
    { global: true },
  );
}

/** Replace tool results older than the last `keepTurns` user messages. */
function clearOldResults(ctx, session, keepTurns, keepTools) {
  const nodes = [...session.surface.nodes];
  const toolNameByCall = new Map();
  const results = [];
  const users = [];

  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event === undefined || event === null) continue;
    if (event.type === "user/message") users.push(seq);
    else if (event.type === "tool/call") {
      if (event.data?.callId !== undefined) toolNameByCall.set(event.data.callId, event.data.name);
    } else if (event.type === "tool/result") results.push({ seq, event });
  }

  const stats = { nodes: nodes.length, users: users.length, results: results.length, count: 0 };
  if (users.length <= keepTurns) return stats;
  const keepFromSeq = users[users.length - keepTurns];
  // Optional: `tokenMeter` throws on plain property access unless declared in `inject`,
  // so it is looked up dynamically and never required for a prune to happen.
  const meter = lookupMeter(ctx);

  for (const { seq, event } of results) {
    if (seq >= keepFromSeq) continue;
    const data = event.data;
    const callId = data.message?.source?.callId;
    if (keepTools.has(toolNameByCall.get(callId))) continue;

    const original = session.deriveEventMessage(event);
    if (textOf(original.content) === MARKER) continue;

    const message = Object.freeze({
      ...original,
      content: Object.freeze([Object.freeze({ type: "text", text: MARKER })]),
    });
    if (meter !== undefined) {
      try {
        session.append("compaction/prune", {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: meter.estimateMessage(original),
        });
      } catch {
        /* the shadow-price event is optional; the surface replacement is the work */
      }
    }
    session.append(
      "tool/result",
      { ...data, message },
      {
        surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      },
    );
    stats.count += 1;
  }
  return stats;
}

function textOf(content) {
  let text = "";
  if (!Array.isArray(content)) return text;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

// `ctx.tokenMeter` throws unless the plugin declares it in `inject`; the dynamic lookup
// keeps the plugin working either way, and the meter only prices the shadowed node.
function lookupMeter(ctx) {
  try {
    const meter = typeof ctx.get === "function" ? ctx.get("tokenMeter") : ctx.tokenMeter;
    return typeof meter?.estimateMessage === "function" ? meter : undefined;
  } catch {
    return undefined;
  }
}

export default { name, apply };
