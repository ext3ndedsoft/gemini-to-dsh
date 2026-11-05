#!/usr/bin/env node
/**
 * antigravity-bridge — OpenAI-compatible endpoint for Antigravity's Cloud Code
 * transport. Lets any OpenAI client (DSH included) drive Gemini 3.8 Flash with
 * native tool calling, using the OAuth session already present in
 * ~/.gemini/oauth_creds.json.
 *
 *   POST /v1/chat/completions   (stream + non-stream, tools, images)
 *   GET  /v1/models
 *   GET  /health
 *
 * This file is routing and nothing else: the protocol work lives in lib/.
 *   lib/config.js      settings, model aliases
 *   lib/http.js        body parsing, JSON/SSE replies, error envelopes
 *   lib/schema.js      tool declarations and thinking configuration
 *   lib/messages.js    OpenAI messages -> Gemini contents
 *   lib/signatures.js  thought-signature cache (memory + disk)
 *   lib/thinking.js    thinking tags -> reasoning channel
 *   lib/upstream.js    request assembly, account rotation
 *   lib/stream.js      streamed completions (with empty-answer retry)
 *   lib/complete.js    non-streamed completions (same retry)
 */

import crypto from 'node:crypto';
import http from 'node:http';

import {
  clearCooldowns,
  cloudPost,
  completeLogin,
  limitsReport,
  listAccounts,
  loadStore,
  orderedAccounts,
  recordLatency,
  removeAccount,
  setEnabled,
  setPinned,
  startLogin,
  warmQuotaSummaries,
} from './accounts.js';
import { HOST, MODEL_ALIASES, PORT, SHARED_SECRET, log } from './lib/config.js';
import {
  htmlPage,
  isLocal,
  jsonBody,
  openAiError,
  sendJson,
} from './lib/http.js';
import { handleOnce } from './lib/complete.js';
import { answerText, generate, routeFor } from './lib/images.js';
import { saveSignatures } from './lib/signatures.js';
import { handleStream } from './lib/stream.js';
import { buildRequest, getCatalog, getProject } from './lib/upstream.js';

async function handleModels(res) {
  let catalog = {};
  try {
    catalog = await getCatalog();
  } catch (err) {
    log('catalog failed: ' + err.message);
  }
  const data = [];
  for (const [id, meta] of Object.entries(catalog)) {
    if (id.startsWith('tab_') || id.startsWith('chat_')) continue;
    data.push({
      id,
      object: 'model',
      name: id,
      owned_by: 'antigravity',
      context_window: meta.maxTokens || 1_048_576,
      max_output_tokens: meta.maxOutputTokens || 65_536,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0',
        completion: '0',
      },
      supported_parameters: ['temperature', 'top_p', 'max_tokens', 'response_format'],
    });
  }
  for (const [alias, target] of MODEL_ALIASES) {
    if (data.some((model) => model.id === alias)) continue;
    const meta = catalog[target] || {};
    data.push({
      id: alias,
      object: 'model',
      name: alias,
      owned_by: 'antigravity',
      context_window: meta.maxTokens || 1_048_576,
      max_output_tokens: meta.maxOutputTokens || 65_536,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0',
        completion: '0',
      },
      supported_parameters: ['temperature', 'top_p', 'max_tokens', 'response_format'],
    });
  }
  sendJson(res, 200, { object: 'list', data });
}

function authorized(req, url) {
  if (url && url.pathname.startsWith('/api/v1/')) {
    return isLocal(req);
  }
  const header = req.headers.authorization || '';
  const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const expected = Buffer.from(SHARED_SECRET);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const PROBE_MODEL = process.env.AG_PROBE_MODEL || 'gemini-3.8-flash';
const PROBE_TIMEOUT_MS = Number(process.env.AG_PROBE_TIMEOUT_MS || 30000);

/**
 * One tiny real request to one account, timed to its first streamed payload.
 * Quota numbers say nothing about a tenant whose shard is melting; a request
 * that actually comes back does. Costs a handful of tokens, on purpose.
 */
async function probeAccount(id) {
  const account = loadStore().accounts.find((acc) => acc.id === id);
  if (!account) return { ok: false, status: 404, error: 'unknown account' };
  const startedAt = Date.now();
  try {
    const payload = buildRequest({
      model: PROBE_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    });
    payload.project = (await getProject(account)) || undefined;
    // A slow account is the thing being measured, so the probe has to outlive
    // the 20 s header budget that protects real turns.
    const upstreamRes = await cloudPost(account, '/v1internal:streamGenerateContent?alt=sse', payload, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      retries: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      return { ok: false, status: upstreamRes.status, error: text.slice(0, 200) || 'upstream ' + upstreamRes.status };
    }
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first = null;
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('data:')) {
        first = Date.now() - startedAt;
        break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      /* the body is already gone */
    }
    if (first === null) return { ok: false, error: 'no answer in ' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' s' };
    recordLatency(account, first);
    return { ok: true, ms: first };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleAccountRoutes(req, res, url) {
  if (!isLocal(req)) return openAiError(res, 403, 'local access only', 'forbidden');
  // Loopback is not a browser boundary: any page open on this machine is "local"
  // too. A text/plain POST is a simple request and would reach these handlers
  // without a preflight, so state changes require JSON, and a cross-origin caller
  // is refused before the body is read.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
      return openAiError(res, 403, 'cross-origin writes are refused', 'forbidden');
    }
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      return openAiError(res, 415, 'content-type must be application/json', 'unsupported_media_type');
    }
  }
  try {
    if (req.method === 'GET' && url.pathname === '/limits') {
      return sendJson(res, 200, await limitsReport({ force: url.searchParams.get('force') === '1' }));
    }
    if (req.method === 'GET' && url.pathname === '/accounts') {
      return sendJson(res, 200, { accounts: listAccounts(), pinned: loadStore().pinned });
    }
    if (req.method === 'POST' && url.pathname === '/accounts/login') {
      return sendJson(res, 200, startLogin());
    }
    if (req.method === 'POST' && url.pathname === '/accounts/pin') {
      const body = await jsonBody(req).catch(() => ({}));
      if (!setPinned(body.id || null)) return openAiError(res, 404, 'unknown account');
      return sendJson(res, 200, { ok: true, pinned: loadStore().pinned });
    }
    // "Move this session to that account": pin it, drop whatever cooldown it
    // collected, and answer with the order the next request will follow.
    if (req.method === 'POST' && url.pathname === '/accounts/switch') {
      const body = await jsonBody(req).catch(() => ({}));
      if (!setPinned(body.id || null)) return openAiError(res, 404, 'unknown account');
      if (body.id) clearCooldowns(body.id);
      const order = orderedAccounts(body.model || '*').map((acc) => acc.email || acc.id);
      log('switch requested -> ' + (loadStore().pinned || 'auto') + ' | order: ' + order.join(' > '));
      return sendJson(res, 200, { ok: true, pinned: loadStore().pinned, order });
    }
    if (req.method === 'POST' && url.pathname === '/accounts/check') {
      const body = await jsonBody(req).catch(() => ({}));
      return sendJson(res, 200, await probeAccount(body.id));
    }
    if (req.method === 'POST' && url.pathname === '/accounts/enabled') {
      const body = await jsonBody(req).catch(() => ({}));
      if (!setEnabled(body.id, body.enabled !== false)) return openAiError(res, 400, 'cannot change that account');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/accounts/remove') {
      const body = await jsonBody(req).catch(() => ({}));
      if (!removeAccount(body.id)) return openAiError(res, 400, 'cannot remove that account');
      return sendJson(res, 200, { ok: true });
    }
    return openAiError(res, 404, 'not found');
  } catch (err) {
    log('account route failed: ' + err.message);
    return openAiError(res, 500, err.message);
  }
}

/**
 * Image turns end here instead of in lib/stream.js: the picture is written to disk
 * and the path goes back as markdown, because a chat client cannot render base64
 * and an "answer" with no text is indistinguishable from a broken turn.
 */
async function handleImage(req, res, body, mode) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let result;
  try {
    result = await generate(body, { signal: controller.signal });
  } catch (err) {
    // 429 is the provider asking for patience, not a bad request: keep it as 429
    // so the client backs off instead of reporting "invalid request".
    const status = err.status === 429 ? 429 : err.status && err.status < 500 ? 400 : 502;
    return openAiError(res, status, err.message, status === 429 ? 'image_busy' : 'image_failed');
  }
  if (!result.files.length) {
    return openAiError(
      res,
      502,
      'the image model returned no picture' + (result.text ? ': ' + result.text.slice(0, 300) : ''),
      'empty_image_response'
    );
  }
  log(`image turn (${mode}) -> ${result.files.length} file(s)`);

  const content = answerText(result.files, result.text);
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const model = body.model;

  if (!body.stream) {
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      images: result.files.map((file) => ({ path: file, type: 'image' })),
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta, finishReason) => {
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }) +
        '\n\n'
    );
  };
  chunk({ role: 'assistant', content: '' }, null);
  chunk({ content }, null);
  chunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);

  // The DSH widget is a browser page on another port, so every response is
  // CORS-enabled; the bridge only listens on loopback anyway. Reflecting *any*
  // origin would let an unrelated page in the same browser read /accounts (the
  // account e-mails) and drive /v1/chat/completions on the operator's quota, so
  // only loopback origins are echoed back. Requests without an Origin header are
  // not browsers and are left alone.
  const origin = req.headers.origin;
  if (!origin) {
    res.setHeader('access-control-allow-origin', '*');
  } else if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  } else {
    // Deliberately no allow-origin header: the browser then refuses to read the
    // response, while the request itself still works for non-browser callers.
    log(`cors: refused origin ${origin}`);
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('vary', 'origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    return sendJson(res, 200, { ok: true, service: 'antigravity-bridge', port: PORT });
  }

  // Reached by a browser redirect from Google, so it carries no bridge token.
  if (req.method === 'GET' && url.pathname === '/oauth/callback') {
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error) return htmlPage(res, 400, 'Login rejected', error);
    if (!code || !state) return htmlPage(res, 400, 'Login failed', 'missing code or state');
    try {
      const account = await completeLogin(code, state);
      log(`added account ${account.email}`);
      const detail = [account.email, account.tierName || account.tier, account.project].filter(Boolean).join(' · ');
      return htmlPage(res, 200, 'Account added', detail);
    } catch (err) {
      return htmlPage(res, 400, 'Login failed', err.message);
    }
  }

  // Operator-facing surface for the DSH limits widget.
  if (url.pathname === '/limits' || url.pathname.startsWith('/accounts')) {
    return handleAccountRoutes(req, res, url);
  }

  if (!authorized(req, url)) {
    return openAiError(res, 401, 'invalid bridge token', 'invalid_api_key');
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/api/v1/models')) {
    return handleModels(res);
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/api/v1/chat/completions')) {
    let body;
    try {
      body = await jsonBody(req);
    } catch (err) {
      return openAiError(res, err.status || 400, err.message);
    }
    if (!body || !Array.isArray(body.messages)) {
      return openAiError(res, 400, 'messages must be an array');
    }
    try {
      // What actually fills the prompt: tool schemas are the usual suspect, and
      // without this line the only place to see their weight is the client UI.
      const toolChars = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0;
      const messageChars = JSON.stringify(body.messages).length;
      log(`shape: model=${body.model} tools=${body.tools?.length || 0} (${toolChars} chars, ~${Math.round(toolChars / 4)} tok) messages=${body.messages.length} (${messageChars} chars, ~${Math.round(messageChars / 4)} tok)`);
      // Asking any model for a picture lands on the image model: words, not a command.
      const imageRoute = routeFor(body);
      if (imageRoute) return await handleImage(req, res, body, imageRoute);
      if (body.stream) await handleStream(req, res, body);
      else await handleOnce(req, res, body);
    } catch (err) {
      log('request failed: ' + (err.stack || err.message));
      openAiError(res, 500, err.message);
    }
    return;
  }

  openAiError(res, 404, 'not found');
});

server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 90_000;

// Keep the five-hour numbers warm so ordering never falls back to "unknown".
const WARM_MS = Number(process.env.AG_QUOTA_WARM_MS || 180_000);
if (WARM_MS > 0) {
  const warm = () => warmQuotaSummaries().catch(() => {});
  setTimeout(warm, 8_000).unref?.();
  setInterval(warm, WARM_MS).unref?.();
}

server.listen(PORT, HOST, () => {
  log(`antigravity-bridge listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveSignatures();
    process.exit(0);
  });
}
process.on('exit', saveSignatures);
