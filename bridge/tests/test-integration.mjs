/**
 * End-to-end test of the part that actually failed in production: what the bridge
 * does when the model returns thoughts and nothing else, or nothing at all.
 *
 * A stub Cloud Code server stands in for Google, so this runs offline with no
 * quota and no accounts. The bridge under test is a real `server.js` on its own
 * port, pointed at the stub through the relay setting.
 *
 *   node test-integration.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sse(res, response) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.write('data: ' + JSON.stringify({ response }) + '\n\n');
  res.end();
}

const attempts = new Map();

/** Stub Cloud Code: behaviour is picked by a marker inside the user message. */
function startStub(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      if (pathname.endsWith(':loadCodeAssist')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ cloudaicompanionProject: 'stub-project' }));
      }
      if (pathname.endsWith(':fetchAvailableModels')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: {} }));
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const contents = body.request?.contents || [];
      const text = contents
        .flatMap((entry) => entry.parts || [])
        .map((part) => part.text || '')
        .join(' ');
      const key = text.includes('never')
        ? 'never'
        : text.includes('longthink')
          ? 'longthink'
          : text.includes('once')
            ? 'once'
            : 'recover';
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);

      const thoughts = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'размышляю, но не отвечаю', thought: true }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 12 },
      };
      const longThoughts = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'д'.repeat(1400), thought: true }, { text: 'ANSWER' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 900, totalTokenCount: 12 },
      };
      const answer = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ANSWER' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      };

      if (key === 'never') return sse(res, thoughts);
      if (key === 'longthink') return sse(res, longThoughts);
      return sse(res, attempt === 1 ? thoughts : answer);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const stubPort = await freePort();
const bridgePort = await freePort();

const egressFile = path.join(work, 'egress.json');
fs.writeFileSync(egressFile, JSON.stringify({ proxy: '', fallbackProxy: '', fallback: 'direct', relay: `http://127.0.0.1:${stubPort}` }));
const credsFile = path.join(work, 'creds.json');
fs.writeFileSync(
  credsFile,
  JSON.stringify({ access_token: 'stub-token', refresh_token: 'stub-refresh', expiry_date: Date.now() + 3_600_000 }),
);
const accountsFile = path.join(work, 'accounts.json');
fs.writeFileSync(accountsFile, JSON.stringify({ accounts: [], pinned: null }));

const stub = await startStub(stubPort);

const bridge = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(HERE, '..'),
  stdio: 'ignore',
  env: {
    ...process.env,
    AG_BRIDGE_PORT: String(bridgePort),
    AG_EGRESS_FILE: egressFile,
    AG_CREDS_FILE: credsFile,
    AG_ACCOUNTS_FILE: accountsFile,
    AG_SIGNATURE_FILE: path.join(work, 'signatures.json'),
    NODE_USE_ENV_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '',
  },
});

const BASE = `http://127.0.0.1:${bridgePort}`;
const headers = { 'content-type': 'application/json', authorization: 'Bearer local-bridge' };

async function waitForHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function cleanup() {
  try {
    bridge.kill();
  } catch {}
  try {
    stub.close();
  } catch {}
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {}
}

try {
  const healthy = await waitForHealth();
  if (!healthy) throw new Error('bridge did not start on ' + BASE);

  console.log('\nempty-turn recovery');

  const streamed = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'recover pls' }] }),
  });
  const raw = await streamed.text();

  check('a thoughts-only turn is retried and answered', () => {
    assert.equal(streamed.status, 200);
    assert.match(raw, /ANSWER/);
    assert.match(raw, /\[DONE\]/);
  });

  // Reasoning from a discarded attempt is streamed as reasoning_content, not as
  // the answer — the client distinguishes the two channels, so the assertion is
  // that the *answer* is the retry's, exactly once.
  check('a dead attempt does not become the answer', () => {
    assert.match(raw, /ANSWER/);
    assert.equal((raw.match(/ANSWER/g) || []).length, 1);
    const contentParts = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || '';
        } catch {
          return '';
        }
      })
      .join('');
    assert.ok(!contentParts.includes('размышляю'), 'a dead attempt leaked into the answer channel');
  });

  check('the answer is not duplicated by the retry', () => {
    assert.equal((raw.match(/ANSWER/g) || []).length, 1);
  });

  check('finish reason is stop and usage is reported', () => {
    assert.match(raw, /"finish_reason":"stop"/);
    assert.match(raw, /"prompt_tokens":10/);
  });

  const once = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'recover once' }] }),
  });
  const onceJson = await once.json();
  check('non-streamed turn recovers the same way', () => {
    assert.equal(once.status, 200);
    assert.equal(onceJson.choices[0].message.content, 'ANSWER');
    assert.equal(onceJson.choices[0].message.reasoning_content, undefined);
  });

  const longthink = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'longthink' }] }),
  });
  const longRaw = await longthink.text();
  check('a long thought still streams through as reasoning', () => {
    assert.equal(longthink.status, 200);
    assert.match(longRaw, /"reasoning_content":"ддд/);
    assert.match(longRaw, /"content":"ANSWER"/);
    const reasoningFirst = longRaw.indexOf('reasoning_content') < longRaw.indexOf('"content":"ANSWER"');
    assert.ok(reasoningFirst, 'reasoning must precede the answer');
  });

  console.log('\nno-answer at all');

  const never = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'never answer' }] }),
  });
  const neverBody = await never.text();
  // A model that only ever emits thoughts produces reasoning and no answer. The
  // turn must not close with finish_reason "stop": clients read that as a finished
  // turn, store an empty answer and stop the agent loop there, so the task looks
  // done while nothing was produced. The honest end of a thought-only turn is an
  // error event on the wire.
  check('a permanently thought-only model ends as an error, not as a finished turn', () => {
    assert.equal(never.status, 200);
    assert.match(neverBody, /"code":"empty_upstream_response"/);
    assert.ok(!neverBody.includes('"finish_reason":"stop"'), 'a thought-only turn must not look finished');
    const answerText = neverBody
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || '';
        } catch {
          return '';
        }
      })
      .join('');
    assert.equal(answerText, '', 'a thought-only turn must not fabricate an answer');
  });

  check('the ladder tried more than once before giving up', () => {
    assert.ok((attempts.get('never') || 0) >= 3, `attempts: ${attempts.get('never')}`);
  });

  console.log('\naccount routes are not reachable from a page');

  // Loopback is not a browser boundary: every tab on this machine is "local" too.
  // A text/plain POST is a simple request, so it arrives without a preflight; the
  // handler has to refuse it, and must refuse a foreign Origin outright.
  const plain = await fetch(BASE + '/accounts/pin', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ id: 'someone@example.com' }),
  });
  check('account writes refuse a non-JSON body', () => {
    assert.equal(plain.status, 415);
  });

  const forged = await fetch(BASE + '/accounts/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ id: 'someone@example.com' }),
  });
  check('account writes refuse a foreign origin', () => {
    assert.equal(forged.status, 403);
  });

  const readOnly = await fetch(BASE + '/accounts');
  check('reading accounts stays allowed', () => {
    assert.equal(readOnly.status, 200);
  });
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
