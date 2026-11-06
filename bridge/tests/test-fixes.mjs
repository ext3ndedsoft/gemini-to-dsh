/**
 * Regression tests for bugs that actually reached a session:
 *   - a 20 s budget on the whole call cut every answer that streamed longer
 *   - the five-hour guard reset itself on every bridge restart
 *   - a short request came back empty because thinking ate the whole window
 *
 *   node tests/test-fixes.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

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

const { thinkingConfig } = await import('../lib/schema.js');
const { withHeaderTimeout, rankScore } = await import('../accounts.js');
const { resetHint } = await import('../lib/http.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

console.log('\nquota reset hints');

await test('"Resets in 156h57m47s" becomes a real deadline', () => {
  const hours = (resetHint('Individual quota reached. Resets in 156h57m47s.') - Date.now()) / 3_600_000;
  assert.ok(hours > 156 && hours < 157.5, `parsed ${hours}h`);
});

await test('a plain "Resets in 45m30s" still parses', () => {
  const minutes = (resetHint('Resource exhausted. Resets in 45m30s.') - Date.now()) / 60_000;
  assert.ok(minutes > 45 && minutes < 46, `parsed ${minutes}m`);
});

await test('an ISO resetTime field wins', () => {
  const iso = new Date(Date.now() + 7_200_000).toISOString();
  const at = resetHint(`{"error":{"details":[{"metadata":{"resetTime":"${iso}"}}]}}`);
  assert.ok(Math.abs(at - (Date.now() + 7_200_000)) < 5000);
});

await test('an error without a hint has none', () => {
  assert.equal(resetHint('upstream said no'), null);
});

console.log('\nupstream budget');

await test('a slow body is not cut by the header budget', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let sent = 0;
    const timer = setInterval(() => {
      res.write('x');
      if ((sent += 1) === 6) {
        clearInterval(timer);
        res.end();
      }
    }, 200);
  });
  const port = await listen(server);
  try {
    const res = await withHeaderTimeout(
      (signal) => fetch(`http://127.0.0.1:${port}/`, { signal }),
      undefined,
      300
    );
    assert.equal(await res.text(), 'xxxxxx');
  } finally {
    server.close();
  }
});

await test('a dead upstream still fails fast before the headers', async () => {
  const server = http.createServer(() => {
    /* accept the request and never answer */
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => withHeaderTimeout((signal) => fetch(`http://127.0.0.1:${port}/`, { signal }), undefined, 300),
      /timeout/i
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

console.log('\naccount store');

await test('rotation settings survive a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rotation-'));
  const file = path.join(dir, 'accounts.json');
  const creds = path.join(dir, 'oauth_creds.json');
  // loadStore imports the native session and saves the store as a side effect; a
  // fake session makes the same write happen without touching the real one.
  fs.writeFileSync(
    creds,
    JSON.stringify({ access_token: 'fake', refresh_token: 'fake', expiry_date: Date.now() + 3600e3 })
  );
  fs.writeFileSync(
    file,
    JSON.stringify({ accounts: [], pinned: null, rotation: { enabled: false, threshold: 0.2 } })
  );
  const script = `
    import fs from 'node:fs';
    process.env.AG_ACCOUNTS_FILE = ${JSON.stringify(file)};
    process.env.AG_CREDS_FILE = ${JSON.stringify(creds)};
    const mod = await import(${JSON.stringify(pathToFileURL(path.join(root, 'accounts.js')).href)});
    const store = mod.loadStore();
    const saved = JSON.parse(fs.readFileSync(process.env.AG_ACCOUNTS_FILE, 'utf8'));
    console.log(JSON.stringify({ memory: store.rotation || null, disk: saved.rotation || null }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const result = JSON.parse(out.trim());
  assert.deepEqual(result.memory, { enabled: false, threshold: 0.2 });
  assert.deepEqual(result.disk, { enabled: false, threshold: 0.2 });
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\nthought signatures');

const { rememberCall, signatureForCall, PLACEHOLDER_SIGNATURE } = await import('../lib/signatures.js');
const { toContents } = await import('../lib/messages.js');

const callPartOf = (built) => built.contents.flatMap((c) => c.parts || []).find((p) => p.functionCall);

await test('a signature is found again after the client rewrote the call id', () => {
  rememberCall('call_orig', 'SIG-A', 'grep', { pattern: 'x', path: '.' });
  assert.equal(signatureForCall('call_rewritten', 'grep', '{"path":".","pattern":"x"}'), 'SIG-A');
});

await test('a replayed call in the current turn never goes out unsigned', () => {
  const contents = toContents([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_unknown', type: 'function', function: { name: 'weird_tool', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'call_unknown', content: 'ok' },
  ]);
  assert.equal(callPartOf(contents).thoughtSignature, PLACEHOLDER_SIGNATURE);
});

await test('an older turn carries its real signature and is not padded', () => {
  rememberCall('call_old', 'SIG-OLD', 'read', { file: 'a' });
  const contents = toContents([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'read', arguments: '{"file":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: 'ok' },
    { role: 'user', content: 'new' },
  ]);
  assert.equal(callPartOf(contents).thoughtSignature, 'SIG-OLD');
});

await test('an oversized signature stays in memory instead of being dropped', () => {
  const big = 'S'.repeat(40_000);
  rememberCall('call_big', big, 'pwsh', { command: 'ls' });
  assert.equal(signatureForCall('call_big', 'pwsh', { command: 'ls' }).length, 40_000);
});

console.log('\naccount ranking');

await test('a fast account outranks a slow one with more quota', () => {
  const slowFull = rankScore(1, 20_000);
  const fastLower = rankScore(0.64, 3_000);
  assert.ok(fastLower > slowFull, `${fastLower} vs ${slowFull}`);
});

await test('unknown latency is never penalised', () => {
  assert.equal(rankScore(0.8, null), 0.8);
});

await test('a hang cannot sink an account further than the cap', () => {
  assert.equal(rankScore(1, 10 * 60_000), 0.25);
});

console.log('\nthinking window');

await test('a tiny output window gets no thinking budget', () => {
  assert.equal(thinkingConfig('high', 32).thinkingBudget, 0);
});

await test('a small but real window still thinks, on half the window', () => {
  assert.equal(thinkingConfig('high', 256).thinkingBudget, 128);
});

await test('a normal window keeps the configured budget', () => {
  assert.ok(thinkingConfig('high', 32768).thinkingBudget >= 1024);
});

await test('AG_THINKING_DEFAULT lowers the cost without touching the client', () => {
  process.env.AG_THINKING_DEFAULT = 'low';
  try {
    const budget = thinkingConfig(undefined, 32768).thinkingBudget;
    assert.ok(budget >= 1024 && budget < 24576, `budget ${budget}`);
  } finally {
    delete process.env.AG_THINKING_DEFAULT;
  }
});

console.log('\nreview fixes');

await test('a cooling account is not promoted by a pin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-pin-'));
  const file = path.join(dir, 'accounts.json');
  const creds = path.join(dir, 'oauth_creds.json');
  fs.writeFileSync(creds, JSON.stringify({ access_token: 'fake', refresh_token: 'fake', expiry_date: Date.now() + 3600e3 }));
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [
        { id: 'pinned-one', email: 'a@example.com', refresh_token: 'fake' },
        { id: 'healthy-one', email: 'b@example.com', refresh_token: 'fake' },
      ],
      pinned: 'pinned-one',
      rotation: { enabled: true, threshold: 0.05 },
      cooldowns: { 'pinned-one|gemini-3.8-flash': Date.now() + 600_000 },
    })
  );
  const script = `
    process.env.AG_ACCOUNTS_FILE = ${JSON.stringify(file)};
    process.env.AG_CREDS_FILE = ${JSON.stringify(creds)};
    const mod = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'accounts.js')).href)});
    const order = mod.orderedAccounts('gemini-3.8-flash').map((acc) => acc.id);
    console.log(JSON.stringify(order));
  `;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    // The module logs while it works, so the answer is the last line of stdout.
    const order = JSON.parse(out.trim().split('\n').pop());
    assert.equal(order[order.length - 1], 'pinned-one', `order ${JSON.stringify(order)}`);
    assert.ok(order.indexOf('pinned-one') > order.indexOf('healthy-one'), `order ${JSON.stringify(order)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('the argument index is evicted with its entry, not kept forever', async () => {
  const { rememberCall, signatureForCall } = await import('../lib/signatures.js');
  rememberCall('call_first_review', 'SIG-FIRST', 'grep', { marker: 'first-review-call' });
  for (let i = 0; i < 5000; i += 1) rememberCall(`call_fill_${i}`, 'FILL-SIG', 'fill', { i });
  assert.equal(signatureForCall('call_first_review', 'grep', { marker: 'first-review-call' }), undefined);
  assert.equal(signatureForCall('call_fill_4999', 'fill', { i: 4999 }), 'FILL-SIG');
});

await test('allOf keeps the properties of every branch', async () => {
  const { toGeminiSchema } = await import('../lib/schema.js');
  const merged = toGeminiSchema({
    allOf: [
      { properties: { a: { type: 'string' } }, required: ['a'] },
      { properties: { b: { type: 'number' } }, required: ['b'] },
    ],
  });
  assert.deepEqual(Object.keys(merged.properties).sort(), ['a', 'b']);
  assert.deepEqual([...merged.required].sort(), ['a', 'b']);
  assert.equal(merged.type, 'OBJECT');
});

await test('a json_schema response format reaches upstream as a Gemini schema', async () => {
  const { buildRequest } = await import('../lib/upstream.js');
  const built = buildRequest({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'x' }],
    response_format: {
      type: 'json_schema',
      json_schema: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  });
  assert.equal(built.request.generationConfig.responseMimeType, 'application/json');
  assert.equal(built.request.generationConfig.responseSchema.type, 'OBJECT');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;