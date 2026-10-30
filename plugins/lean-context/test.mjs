// Offline check of the lean-context plugin: fake session/ctx, no DSH needed.
import { apply } from "./index.js";

function msg(callId, text) {
  return { role: "tool", content: [{ type: "text", text }], source: { callId } };
}

function makeSession(id) {
  const events = [];
  const push = (type, data) => {
    events.push({ seq: events.length, type, data, onSurface: true });
    return events[events.length - 1].seq;
  };
  push("system/message", { turn: 1, step: 0 });
  push("user/message", { turn: 1, step: 0 });
  push("tool/call", { turn: 1, step: 1, callId: "c1", name: "read" });
  push("tool/result", { turn: 1, step: 1, message: msg("c1", "FILE CONTENT A") });
  push("tool/call", { turn: 1, step: 1, callId: "c2", name: "skill" });
  push("tool/result", { turn: 1, step: 1, message: msg("c2", "SKILL INSTRUCTIONS") });
  push("user/message", { turn: 2, step: 0 });
  push("tool/call", { turn: 2, step: 1, callId: "c3", name: "grep" });
  push("tool/result", { turn: 2, step: 1, message: msg("c3", "GREP HITS") });
  push("user/message", { turn: 3, step: 0 });
  push("tool/call", { turn: 3, step: 1, callId: "c4", name: "read" });
  push("tool/result", { turn: 3, step: 1, message: msg("c4", "FILE CONTENT D") });
  push("user/message", { turn: 4, step: 0 });
  push("tool/call", { turn: 4, step: 1, callId: "c5", name: "read" });
  push("tool/result", { turn: 4, step: 1, message: msg("c5", "FILE CONTENT E") });

  return {
    id,
    events,
    get surface() {
      return { nodes: events.filter((e) => e.onSurface).map((e) => e.seq) };
    },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (event) => event.data.message,
    append(type, data, opts) {
      const seq = events.length;
      events.push({ seq, type, data, onSurface: true });
      if (opts?.surfaceOp?.op === "replace") events[opts.surfaceOp.startSeq].onSurface = false;
      return { seq };
    },
  };
}

const handlers = {};
const logs = [];
const ctx = {
  on(event, fn) {
    handlers[event] = fn;
  },
  logger: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`) },
  tokenMeter: { estimateMessage: () => 42 },
};
apply(ctx, { keepTurns: 2, keepTools: ["skill"] });

const session = makeSession("session-alpha");
handlers["session/event"](session);

const step = () =>
  handlers["agent/pre-step"]({ agent: {}, signal: { aborted: false } }, async () => "next");
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) process.exitCode = 1;
};

await step();

const texts = session.surface.nodes.map(
  (seq) => session.eventAt(seq).data.message?.content?.[0]?.text ?? "",
);
const has = (t) => texts.some((x) => x.includes(t));

check("old turn-1 file content cleared", !has("FILE CONTENT A"));
check("skill result kept", has("SKILL INSTRUCTIONS"));
check("old turn-2 grep cleared", !has("GREP HITS"));
check("kept turn-3 content intact", has("FILE CONTENT D"));
check("current turn-4 content intact", has("FILE CONTENT E"));
check("marker placed", has("[old tool result cleared]"));
const before = session.events.length;
await step();
check("no duplicate replacements on second step", session.events.length === before);
check("shadow-price event written", session.events.some((e) => e.type === "compaction/prune"));
check("no warnings", !logs.some((l) => l.startsWith("WARN")));

// A ctx without an injectable meter (cordis throws on plain property access) must
// still prune instead of failing the step.
const seen2 = {};
const handlers2 = {};
apply(
  {
    on: (e, fn) => {
      handlers2[e] = fn;
    },
    logger: { info: (m) => (seen2.info = m), warn: (m) => (seen2.warn = m) },
    get() {
      throw new Error('cannot get property "tokenMeter" without inject');
    },
  },
  { keepTurns: 2, keepTools: ["skill"] },
);
const session2 = makeSession("session-beta");
handlers2["session/event"](session2);
await handlers2["agent/pre-step"]({ agent: {}, signal: { aborted: false } }, async () => "next");
const clearedWithoutMeter = session2.surface.nodes
  .map((seq) => session2.eventAt(seq).data.message?.content?.[0]?.text ?? "")
  .filter((t) => t === "[old tool result cleared]").length;
check("prunes without an injectable meter", clearedWithoutMeter === 2);
check("no warning without an injectable meter", seen2.warn === undefined);

console.log(logs.join("\n"));
