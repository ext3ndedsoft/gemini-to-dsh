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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;