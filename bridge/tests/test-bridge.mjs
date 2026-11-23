/**
 * Offline tests for the bridge's protocol layer. No network, no quota, no
 * accounts — everything here is a pure function that broke at least once:
 *
 *   node test-bridge.mjs
 */

import assert from 'node:assert/strict';

import { buildPingPayload } from '../lib/cache-keepalive.js';
import { retryBody } from '../lib/stream.js';
import { buildRequest } from '../lib/upstream.js';
import { thinkingConfig, toGeminiSchema, toolDeclarations } from '../lib/schema.js';
import { finalizeSources, parseSearchResponse } from '../lib/search.js';
import { ThinkingStream, splitThinking } from '../lib/thinking.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function collect(stream, chunks) {
  const pieces = [];
  for (const chunk of chunks) pieces.push(...stream.push(chunk));
  pieces.push(...stream.flush());
  const reasoning = pieces.filter((p) => p.kind === 'reasoning').map((p) => p.text).join('');
  const content = pieces.filter((p) => p.kind === 'content').map((p) => p.text).join('');
  return { reasoning, content };
}

console.log('\nthinking tags -> reasoning channel');

test('leading <thinking> block moves to reasoning', () => {
  const out = splitThinking('<thinking>\nread the file first\n</thinking>\nDone.');
  assert.equal(out.reasoning, '\nread the file first\n');
  assert.equal(out.content, '\nDone.');
});

test('multi-line thinking block is split', () => {
  const out = splitThinking('<thinking>\nline one\nline two\n</thinking>\nanswer');
  assert.equal(out.reasoning, '\nline one\nline two\n');
  assert.equal(out.content, '\nanswer');
});

test('streamed split across chunks is byte-identical', () => {
  const text = '<thinking>step one, step two</thinking>result';
  const oneShot = splitThinking(text);
  const perChar = collect(new ThinkingStream(), [...text]);
  assert.equal(perChar.reasoning, oneShot.reasoning);
  assert.equal(perChar.content, oneShot.content);
});

test('opening tag split mid-tag is not leaked as content', () => {
  const out = collect(new ThinkingStream(), ['<thin', 'king>', 'secret', '</thin', 'king>', 'visible']);
  assert.equal(out.reasoning, 'secret');
  assert.equal(out.content, 'visible');
});

test('plain answer is untouched', () => {
  const out = splitThinking('A plain answer with no tags.');
  assert.equal(out.reasoning, '');
  assert.equal(out.content, 'A plain answer with no tags.');
});

test('a non-thinking tag at the start stays content', () => {
  const out = splitThinking('<div>hi</div>');
  assert.equal(out.reasoning, '');
  assert.equal(out.content, '<div>hi</div>');
});

test('unclosed thinking tag still yields reasoning, never content', () => {
  const out = splitThinking('<thinking>thinking without an end');
  assert.equal(out.reasoning, 'thinking without an end');
  assert.equal(out.content, '');
});

test('a tag after real text is left alone', () => {
  const out = splitThinking('Sure. <thinking>not a leading block</thinking>');
  assert.equal(out.reasoning, '');
  assert.equal(out.content, 'Sure. <thinking>not a leading block</thinking>');
});

test('leading whitespace before the tag is dropped with it', () => {
  const out = splitThinking('\n\n<thinking>x</thinking>y');
  assert.equal(out.reasoning, 'x');
  assert.equal(out.content, 'y');
});

test('lone "<" is flushed as content on end of stream', () => {
  const out = collect(new ThinkingStream(), ['<']);
  assert.equal(out.content, '<');
});

console.log('\ntool declarations');

const sampleParameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'file path' },
    limit: { type: 'integer', enum: [10, 50, 100] },
  },
  required: ['path'],
};

test('OpenAI-shaped tool keeps its schema', () => {
  const [group] = toolDeclarations([{ type: 'function', function: { name: 'read', parameters: sampleParameters } }]);
  const declaration = group.functionDeclarations[0];
  assert.equal(declaration.name, 'read');
  assert.equal(declaration.parameters.type, 'OBJECT');
  assert.deepEqual(declaration.parameters.required, ['path']);
  assert.equal(declaration.parameters.properties.limit.type, 'INTEGER');
  assert.deepEqual(declaration.parameters.properties.limit.enum, [10, 50, 100]);
});

test('bare {name, description, parameters} tools are accepted too', () => {
  const [group] = toolDeclarations([{ name: 'glob', parameters: sampleParameters }]);
  assert.equal(group.functionDeclarations.length, 1);
  assert.equal(group.functionDeclarations[0].name, 'glob');
});

test('unnamed tools are skipped instead of crashing', () => {
  const groups = toolDeclarations([{ type: 'function', function: {} }, { type: 'function', function: { name: 'x' } }]);
  assert.equal(groups[0].functionDeclarations.length, 1);
});

test('no tools means no tools block', () => {
  assert.equal(toolDeclarations([]), null);
  assert.equal(toolDeclarations(undefined), null);
});

console.log('\nschema fidelity');

test('nullable union collapses to the real type', () => {
  assert.equal(toGeminiSchema({ type: ['string', 'null'] }).type, 'STRING');
});

test('anyOf picks the non-null branch', () => {
  assert.equal(toGeminiSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] }).type, 'INTEGER');
});

test('numeric enum is not stringified', () => {
  assert.deepEqual(toGeminiSchema({ type: 'integer', enum: [1, 2] }).enum, [1, 2]);
});

test('string enum stays strings', () => {
  assert.deepEqual(toGeminiSchema({ type: 'string', enum: ['a', 'b'] }).enum, ['a', 'b']);
});

test('arrays always carry items', () => {
  const schema = toGeminiSchema({ type: 'array', items: { type: 'number' } });
  assert.equal(schema.type, 'ARRAY');
  assert.equal(schema.items.type, 'NUMBER');
});

test('object without properties is still a usable OBJECT', () => {
  assert.deepEqual(toGeminiSchema({ additionalProperties: true }), { type: 'OBJECT', properties: {} });
});

console.log('\nthinking budget');

test('high effort leaves room for the answer', () => {
  assert.equal(thinkingConfig('high', undefined).thinkingBudget, 24576);
  assert.equal(thinkingConfig('high', 4096).thinkingBudget, 3072);
});

test('thinking never eats the whole answer window', () => {
  // A liveness probe is the one case with no room for a thought at all.
  assert.equal(thinkingConfig('high', 32).thinkingBudget, 0);
  assert.equal(thinkingConfig('high', 128).thinkingBudget, 0);
  // A small but real window keeps at least half for the answer.
  for (const cap of [256, 512, 1024]) {
    const budget = thinkingConfig('high', cap).thinkingBudget;
    assert.ok(budget > 0 && budget <= cap / 2, `budget ${budget} in a ${cap}-token window`);
  }
  // A large window reserves the answer's kilobyte instead.
  for (const cap of [2048, 8192, 32768]) {
    const budget = thinkingConfig('high', cap).thinkingBudget;
    assert.ok(cap - budget >= 1024, `budget ${budget} leaves ${cap - budget} for a ${cap}-token answer`);
  }
});

test('forced modes turn thoughts off or minimal for a retry', () => {
  assert.deepEqual(thinkingConfig('high', 8192, 'minimal'), { thinkingBudget: 128, includeThoughts: true });
  assert.deepEqual(thinkingConfig('high', 8192, 'off'), { thinkingBudget: 0, includeThoughts: false });
});

console.log('\nempty-turn retry ladder');

const base = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] };

test('first attempt is the caller request untouched', () => {
  assert.equal(retryBody(base, 0), base);
});

test('second attempt reduces thinking and drops reasoning output', () => {
  const next = retryBody(base, 1);
  assert.equal(next.__thinking, 'minimal');
  assert.equal(next.__suppressReasoning, true);
  assert.equal(next.messages.length, base.messages.length);
});

test('third attempt also pushes the model to answer', () => {
  const next = retryBody(base, 2);
  assert.equal(next.messages.length, base.messages.length + 1);
  assert.equal(next.messages.at(-1).role, 'system');
});

// Upstream rejects a parts entry that is a list, so every system/developer
// message has to be joined into one plain instruction block.
test('system messages become a single text part', () => {
  const { request } = buildRequest({
    messages: [
      { role: 'system', content: 'first rule' },
      { role: 'developer', content: 'second rule' },
      { role: 'user', content: 'hello' },
    ],
  });
  const parts = request.systemInstruction?.parts;
  assert.ok(Array.isArray(parts), 'systemInstruction.parts must be an array');
  assert.equal(parts.length, 1);
  assert.equal(typeof parts[0].text, 'string');
  assert.equal(parts[0].text, 'first rule\n\nsecond rule');
  assert.equal(request.safetySettings, undefined, 'the bridge must not override upstream safety defaults');
});

test('DSH harness boilerplate normalizes to Antigravity identity without touching custom rules', () => {
  const { request } = buildRequest({
    messages: [
      {
        role: 'system',
        content:
          'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the gemini-4-hydrogen-sonar model.\n\nFollow project rules.',
      },
      { role: 'user', content: 'hello' },
    ],
  });
  const text = request.systemInstruction?.parts?.[0]?.text || '';
  assert.ok(text.startsWith('You are Antigravity, a powerful agentic AI coding assistant'));
  assert.ok(!/DeepSeek Harness/i.test(text));
  assert.ok(text.includes('Follow project rules.'));
});

console.log('\nsession affinity & tool cache');

test('buildRequest derives stable FNV-1a int64 sessionId and Antigravity envelope across turns', () => {
  const turn1 = buildRequest({
    model: 'gemini-4-hydrogen',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello world' }],
  });
  const turn2 = buildRequest({
    model: 'gemini-4-hydrogen',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next step' },
    ],
  });
  assert.match(turn1.request.sessionId, /^-?\d+$/);
  assert.equal(turn1.request.sessionId, turn2.request.sessionId);
  assert.equal(turn1.userAgent, 'antigravity');
  assert.equal(turn1.requestType, 'agent');
  assert.match(turn1.requestId, /^agent\/[0-9a-f-]+$/i);
  assert.match(turn1.userPromptId, /^bot-[0-9a-f-]+$/i);
});

test('buildRequest hashes explicit __sessionId deterministically into int64 format', () => {
  const req1 = buildRequest({
    model: 'gemini-4-hydrogen',
    __sessionId: 'dsh-sess-42',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const req2 = buildRequest({
    model: 'gemini-4-hydrogen',
    __sessionId: 'dsh-sess-42',
    messages: [{ role: 'user', content: 'different' }],
  });
  assert.match(req1.request.sessionId, /^-?\d+$/);
  assert.equal(req1.request.sessionId, req2.request.sessionId);
  assert.notEqual(req1.request.sessionId, 'dsh-sess-42');
});

test('toolDeclarations caches identical tool schemas', () => {
  const tools = [{ type: 'function', function: { name: 'read', parameters: sampleParameters } }];
  const first = toolDeclarations(tools);
  const second = toolDeclarations([{ type: 'function', function: { name: 'read', parameters: sampleParameters } }]);
  assert.equal(first, second);
});

test('buildPingPayload preserves thinkingConfig, sessionId, and Antigravity envelope while capping output to 1 token', () => {
  const req = buildRequest({
    model: 'gemini-4-hydrogen',
    reasoning_effort: 'high',
    max_tokens: 65536,
    __sessionId: 'ag-keepalive-test',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const ping = buildPingPayload(req);
  assert.equal(ping.request.sessionId, req.request.sessionId);
  assert.equal(ping.userAgent, 'antigravity');
  assert.equal(ping.requestType, req.requestType);
  assert.notEqual(ping.requestId, req.requestId);
  assert.equal(ping.request.generationConfig.maxOutputTokens, 1);
  assert.deepEqual(ping.request.generationConfig.thinkingConfig, req.request.generationConfig.thinkingConfig);
});

console.log('\nweb search grounding');

test('parseSearchResponse extracts answer, queries, and chunk snippets from groundingSupports', () => {
  const parsed = parseSearchResponse({
    response: {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ thought: true, text: 'internal' }, { text: 'Node 24.22.3 is latest.' }],
          },
          groundingMetadata: {
            webSearchQueries: ['node 24 latest'],
            groundingChunks: [
              { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'nodejs.org' } },
              { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/def', title: 'endoflife.date' } },
            ],
            groundingSupports: [
              { segment: { text: 'Node 24.22.3 released Nov 11, 2026.' }, groundingChunkIndices: [0, 1] },
              { segment: { text: 'Maintenance LTS until 2028.' }, groundingChunkIndices: [1] },
            ],
          },
        },
      ],
    },
  });
  assert.equal(parsed.content, 'Node 24.22.3 is latest.');
  assert.deepEqual(parsed.queries, ['node 24 latest']);
  assert.equal(parsed.rawSources.length, 2);
  assert.equal(parsed.rawSources[0].snippet, 'Node 24.22.3 released Nov 11, 2026.');
  assert.equal(parsed.rawSources[1].snippet, 'Node 24.22.3 released Nov 11, 2026. Maintenance LTS until 2028.');
});

await test('finalizeSources resolves redirects, dedupes merged URLs, and sets truncated', async () => {
  const map = {
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/1': 'https://nodejs.org/en/download',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/2': 'https://nodejs.org/en/download',
    'https://vertexaisearch.cloud.google.com/grounding-api-redirect/3': 'https://endoflife.date/nodejs',
  };
  const out = await finalizeSources(
    [
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/1', title: 'nodejs.org', snippet: 'First.' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/2', title: 'nodejs.org', snippet: 'Second.' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/3', title: 'endoflife.date', snippet: 'EOL.' },
    ],
    1,
    { resolveUrl: async (u) => map[u] || u },
  );
  assert.equal(out.truncated, true);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].url, 'https://nodejs.org/en/download');
  assert.equal(out.sources[0].snippet, 'First. Second.');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
