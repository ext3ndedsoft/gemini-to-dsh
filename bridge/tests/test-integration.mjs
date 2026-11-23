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
const seenUpstream = { loadCodeAssist: null, search: null, chat: null };

// A cut turn: the first leg stops mid-sentence, the continuation starts one
// sentence early. The repeat has to be trimmed, not delivered twice.
const CUT_FIRST = 'Первый абзац ответа заканчивается здесь. ';
const CUT_REPEAT = 'заканчивается здесь. ';
const CUT_REST = 'Второй абзац пришёл после обрыва.';

/** Stub Cloud Code: behaviour is picked by a marker inside the user message. */
function startStub(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (pathname.endsWith(':loadCodeAssist')) {
        seenUpstream.loadCodeAssist = { ua: req.headers['user-agent'], body };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ cloudaicompanionProject: 'stub-project' }));
      }
      if (pathname.endsWith(':fetchAvailableModels')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: {}, webSearchModelIds: ['gemini-3.5-flash-lite'] }));
      }

      const contents = body.request?.contents || [];
      const text = contents
        .flatMap((entry) => entry.parts || [])
        .map((part) => part.text || '')
        .join(' ');
      if (Array.isArray(body.request?.tools) && body.request.tools.some((t) => t && t.googleSearch)) {
        seenUpstream.search = { ua: req.headers['user-agent'], body };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            response: {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'Grounded summary for stub query.' }] },
                  finishReason: 'STOP',
                  groundingMetadata: {
                    webSearchQueries: ['stub search query'],
                    groundingChunks: [
                      { web: { uri: 'https://docs.example.com/release', title: 'docs.example.com' } },
                      { web: { uri: 'https://example.org/notes', title: 'example.org' } },
                    ],
                    groundingSupports: [
                      { segment: { text: 'Release v2.0 shipped.' }, groundingChunkIndices: [0] },
                    ],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
            },
          }),
        );
      }
      seenUpstream.chat = { ua: req.headers['user-agent'], body };
      if (text.includes('echo-session')) {
        return sse(res, {
          candidates: [{ content: { role: 'model', parts: [{ text: 'SID:' + (body.request?.sessionId || 'none') }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        });
      }
      if (text.includes('ping')) {
        return sse(res, {
          candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        });
      }
      if (text.includes('cutme')) {
        const continued = text.includes('The transport cut the previous reply');
        const parts = continued ? [{ text: CUT_REPEAT + CUT_REST }] : [{ text: CUT_FIRST }];
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        // The cut leg carries no finishReason and no closing frame: that is what a
        // relay dropping a long stream looks like on the wire.
        const response = {
          candidates: [
            { content: { role: 'model', parts }, ...(continued ? { finishReason: 'STOP' } : {}) },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        res.write('data: ' + JSON.stringify({ response }) + '\n\n');
        return res.end();
      }
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

  console.log('\na cut answer is continued');

  const cut = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'cutme' }] }),
  });
  const cutRaw = await cut.text();
  const cutAnswer = cutRaw
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

  check('a transport cut mid-answer is completed instead of failing the turn', () => {
    assert.equal(cut.status, 200);
    assert.ok(cutAnswer.startsWith(CUT_FIRST), `got: ${JSON.stringify(cutAnswer)}`);
    assert.ok(cutAnswer.includes(CUT_REST), 'the continuation never reached the client');
    assert.ok(!cutRaw.includes('"code":"stream_interrupted"'), 'the turn was reported as failed');
    assert.match(cutRaw, /"finish_reason":"stop"/);
  });

  check('the sentence the model repeated is delivered once', () => {
    assert.equal(
      cutAnswer.split(CUT_REPEAT).length - 1,
      1,
      `got: ${JSON.stringify(cutAnswer)}`
    );
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

  const routeTest = await fetch(BASE + '/accounts/test-route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash' }),
  });
  const routeJson = await routeTest.json();
  check('local /accounts/test-route works without bearer secret', () => {
    assert.equal(routeTest.status, 200);
    assert.equal(routeJson.ok, true);
  });

  const sidHeader = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'x-session-id': 'sess-hdr-99' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'echo-session' }] }),
  });
  const sidHeaderJson = await sidHeader.json();
  const sidHeader2 = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'x-session-id': 'sess-hdr-99' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'echo-session other' }] }),
  });
  const sidHeader2Json = await sidHeader2.json();
  check('x-session-id header hashes deterministically into int64 request.sessionId', () => {
    assert.equal(sidHeader.status, 200);
    assert.match(sidHeaderJson.choices[0].message.content, /^SID:-?\d+$/);
    assert.equal(sidHeaderJson.choices[0].message.content, sidHeader2Json.choices[0].message.content);
  });

  const sidTurn1 = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'echo-session turn1' }] }),
  });
  const sidTurn2 = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'echo-session turn1' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'follow up' },
      ],
    }),
  });
  const sid1 = (await sidTurn1.json()).choices[0].message.content;
  const sid2 = (await sidTurn2.json()).choices[0].message.content;
  check('derived sessionId stays identical across turns', () => {
    assert.match(sid1, /^SID:-?\d+$/);
    assert.equal(sid1, sid2);
  });

  console.log('\nweb search endpoint & model config');

  const searchCfg0 = await fetch(BASE + '/search/config');
  const searchCfg0Json = await searchCfg0.json();
  check('GET /search/config returns default search model list', () => {
    assert.equal(searchCfg0.status, 200);
    assert.equal(searchCfg0Json.model, null);
    assert.ok(Array.isArray(searchCfg0Json.models) && searchCfg0Json.models.includes('gemini-3.5-flash-lite'));
  });

  const setSearchRes = await fetch(BASE + '/search/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-2.5-flash' }),
  });
  const setSearchJson = await setSearchRes.json();
  check('POST /search/model updates default search model', () => {
    assert.equal(setSearchRes.status, 200);
    assert.equal(setSearchJson.model, 'gemini-2.5-flash');
    assert.equal(setSearchJson.effectiveModel, 'gemini-2.5-flash');
  });

  const resetSearchRes = await fetch(BASE + '/search/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: null }),
  });
  const resetSearchJson = await resetSearchRes.json();
  check('POST /search/model null resets back to auto', () => {
    assert.equal(resetSearchRes.status, 200);
    assert.equal(resetSearchJson.model, null);
  });

  const searchRes = await fetch(BASE + '/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'stub search query', maxResults: 5 }),
  });
  const searchJson = await searchRes.json();
  check('POST /v1/search returns grounded summary, sources, and queries', () => {
    assert.equal(searchRes.status, 200);
    assert.equal(searchJson.object, 'search.result');
    assert.equal(searchJson.content, 'Grounded summary for stub query.');
    assert.deepEqual(searchJson.queries, ['stub search query']);
    assert.equal(searchJson.sources.length, 2);
    assert.equal(searchJson.sources[0].url, 'https://docs.example.com/release');
    assert.equal(searchJson.sources[0].snippet, 'Release v2.0 shipped.');
    assert.equal(searchJson.truncated, false);
  });

  const badSearch = await fetch(BASE + '/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: '   ' }),
  });
  check('POST /v1/search rejects empty query with 400', () => {
    assert.equal(badSearch.status, 400);
  });

  const unauthSearch = await fetch(BASE + '/v1/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test' }),
  });
  check('POST /v1/search enforces bearer auth', () => {
    assert.equal(unauthSearch.status, 401);
  });

  check('upstream requests carry Antigravity 2.34.0 identity and envelope fields', () => {
    assert.match(seenUpstream.loadCodeAssist?.ua || '', /^antigravity\/hub\/2\.34\.0 \(os_type=\w+; arch=\w+; aidev_client\)$/);
    assert.equal(seenUpstream.loadCodeAssist?.body?.metadata?.ideType, 'ANTIGRAVITY');
    assert.equal(seenUpstream.loadCodeAssist?.body?.metadata?.ideVersion, '2.34.0');
    assert.equal(seenUpstream.loadCodeAssist?.body?.metadata?.ideName, 'antigravity');
    assert.equal(seenUpstream.search?.body?.userAgent, 'antigravity');
    assert.equal(seenUpstream.search?.body?.requestType, 'web_search');
    assert.match(seenUpstream.search?.body?.requestId || '', /^web_search\/[0-9a-f-]+$/i);
    assert.equal(seenUpstream.chat?.body?.userAgent, 'antigravity');
    assert.match(seenUpstream.chat?.body?.requestType || '', /^(agent|chat)$/);
    assert.match(seenUpstream.chat?.body?.requestId || '', /^(agent|chat)\/[0-9a-f-]+$/i);
  });
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
