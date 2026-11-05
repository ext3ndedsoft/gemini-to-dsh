/**
 * Offline tests for the bridge's protocol layer. No network, no quota, no
 * accounts — everything here is a pure function that broke at least once:
 *
 *   node test-bridge.mjs
 */

import assert from 'node:assert/strict';

import { retryBody } from '../lib/stream.js';
import { buildRequest } from '../lib/upstream.js';
import { thinkingConfig, toGeminiSchema, toolDeclarations } from '../lib/schema.js';
import { ThinkingStream, splitThinking } from '../lib/thinking.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

test('forced modes turn thoughts off for a retry', () => {
  assert.deepEqual(thinkingConfig('high', 8192, 'minimal'), { thinkingBudget: 128, includeThoughts: false });
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
