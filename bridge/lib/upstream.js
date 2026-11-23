/**
 * The Cloud Code side: request assembly, account rotation and the two service
 * calls the bridge exposes (/v1/models and the project id).
 */

import crypto from 'node:crypto';
import {
  accountMeta,
  accountModels,
  cloudPost,
  loadStore,
  markCooling,
  networkReason,
  noteRequest,
  orderedAccounts,
  primaryAccount,
  recordLatency,
} from '../accounts.js';
import { cancelKeepAlive } from './cache-keepalive.js';
import {
  DEFAULT_PROJECT,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_TOTAL_MS,
  isConfiguredAlias,
  log,
  resolveModel,
} from './config.js';
import { resetHint } from './http.js';
import { toContents } from './messages.js';
import { functionCallingConfig, thinkingConfig, toGeminiSchema, toolDeclarations } from './schema.js';

const ANTIGRAVITY_IDENTITY =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.';

function normalizeSystemIdentity(text) {
  if (!text || process.env.AG_IDENTITY_REWRITE === '0') return text;
  if (!/DeepSeek Harness/i.test(text)) return text;
  return text
    .replace(
      /^You are an AI agent powered by DeepSeek Harness\.(?:\s*\n+You are a coding agent powered by the [^\n]+ model\.)?/i,
      ANTIGRAVITY_IDENTITY,
    )
    .replace(/DeepSeek Harness/gi, 'Antigravity');
}

export async function getProject(account) {
  const acc = account || primaryAccount();
  if (!acc) return DEFAULT_PROJECT;
  try {
    const meta = await accountMeta(acc);
    return meta.project || DEFAULT_PROJECT;
  } catch (err) {
    log('loadCodeAssist failed: ' + err.message);
    return DEFAULT_PROJECT;
  }
}

export async function getCatalog() {
  const account = primaryAccount();
  if (!account) return {};
  try {
    return (await accountModels(account)).models;
  } catch (err) {
    log('catalog failed: ' + err.message);
    return {};
  }
}

function fnv1a64Signed(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(String(text || ''), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return BigInt.asIntN(64, hash).toString(10);
}

function deriveSessionId(body, model, systemText, contents) {
  if (typeof body.__sessionId === 'string' && body.__sessionId.trim()) {
    const raw = body.__sessionId.trim().slice(0, 128);
    return /^-?\d{1,20}$/.test(raw) ? raw : fnv1a64Signed(raw);
  }
  const first = Array.isArray(contents) && contents.length ? JSON.stringify(contents[0]).slice(0, 2048) : '';
  const seed = `${model}|${(systemText || '').slice(0, 1024)}|${first}`;
  return fnv1a64Signed(seed);
}

export function buildRequest(body) {
  const { system, contents } = toContents(body.messages);

  // The caller's messages are translated as they are: no injected prologue, no
  // safety override. Only DSH's own harness boilerplate is normalized to the
  // Antigravity client identity when present.
  const request = { contents };

  // toContents() collects every system/developer message into one list; Google
  // wants a single instruction block, so they are joined in order.
  const systemText = normalizeSystemIdentity(system.join('\n\n'));
  if (systemText) request.systemInstruction = { parts: [{ text: systemText }] };

  const tools = toolDeclarations(body.tools);
  if (tools) {
    request.tools = tools;
    const toolConfig = functionCallingConfig(body.tool_choice);
    if (toolConfig) request.toolConfig = toolConfig;
  }

  const model = resolveModel(body.model, { raw: body.__rawModel, effort: body.reasoning_effort });
  // Pin Cloud Code's backend KV-cache routing to the same session across turns
  // and socket reconnects instead of hopping pods on every new TCP connection.
  request.sessionId = deriveSessionId(body, model, systemText, contents);

  const generationConfig = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') generationConfig.maxOutputTokens = body.max_completion_tokens;
  if (Array.isArray(body.stop) && body.stop.length) generationConfig.stopSequences = body.stop.slice(0, 5);
  generationConfig.thinkingConfig = thinkingConfig(body.reasoning_effort, generationConfig.maxOutputTokens, body.__thinking, model);
  if (body.response_format) {
    if (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema') {
      generationConfig.responseMimeType = 'application/json';
      if (body.response_format.json_schema?.schema) {
        // Gemini wants its own Schema shape: types in upper case, no JSON-Schema
        // keywords. The raw OpenAI schema is rejected outright with a 400.
        generationConfig.responseSchema = toGeminiSchema(body.response_format.json_schema.schema);
      }
    }
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const requestType = tools || systemText ? 'agent' : 'chat';
  return {
    project: body.__project || null,
    requestId: `${requestType}/${crypto.randomUUID()}`,
    model,
    userPromptId: `bot-${crypto.randomUUID()}`,
    userAgent: 'antigravity',
    requestType,
    request,
  };
}

const PERMANENT_403 = /disabled in this account|violation of Terms of Service|Verify your account/i;

/**
 * One attempt, walking the account pool. A dead token or a quota/geo/capacity
 * refusal on one account must not fail the request while another account can
 * still serve it.
 */
export async function upstream(body, signal, { totalBudgetMs = UPSTREAM_TOTAL_MS } = {}) {
  const model = resolveModel(body.model, { raw: body.__rawModel, effort: body.reasoning_effort });
  const forced = body.account ? loadStore().accounts.filter((acc) => acc.id === body.account) : [];
  const candidates = forced.length ? forced : orderedAccounts(model);
  if (!candidates.length) {
    throw Object.assign(new Error('no Antigravity accounts configured'), { status: 401 });
  }

  let last = null;
  const deadline = Date.now() + Math.max(15_000, totalBudgetMs);
  // Assembled once: the body does not depend on the account, only the project id
  // does, and rebuilding it per candidate re-ran the schema conversion for every
  // rotation and retry.
  const payload = buildRequest(body);
  cancelKeepAlive(payload.request.sessionId);
  for (let index = 0; index < candidates.length; index += 1) {
    const remaining = deadline - Date.now();
    if (index > 0 && remaining < 10_000) {
      log(`upstream budget exhausted before trying account ${candidates[index].id} for ${model}`);
      break;
    }
    const account = candidates[index];
    payload.project = (await getProject(account)) || DEFAULT_PROJECT;

    let res;
    const startedAt = Date.now();
    noteRequest(account);
    try {
      const isImg = /(?:^|[-_/])image(?:$|[-_/])/.test(model);
      const perTry = Math.min(isImg ? 90_000 : UPSTREAM_TIMEOUT_MS, Math.max(10_000, deadline - Date.now()));
      res = await cloudPost(account, '/v1internal:streamGenerateContent?alt=sse', payload, {
        signal,
        timeoutMs: perTry,
      });
    } catch (err) {
      // A cancelled turn is not the account's fault: the person pressed stop (or
      // walked away), so there is nothing to cool down and nothing to blame.
      if (signal?.aborted) throw err;
      // The failure is a measurement too: an account that hangs for the whole
      // header budget has earned its latency reading, or the ranking keeps putting
      // it first and the person keeps waiting for the whole budget before failover.
      recordLatency(account, Date.now() - startedAt);
      log(`account ${account.id} threw for ${model} after ${Date.now() - startedAt}ms: ${networkReason(err)}`);
      markCooling(account, model, Date.now() + 300_000);
      if (index === candidates.length - 1) {
        if (last) return last;
        throw err;
      }
      continue;
    }

    if (res.ok) {
      // The answer has not started until a payload arrives, so time-to-first-token
      // is recorded where it is read, not where the request is sent.
      try {
        res.__agAccount = account;
        res.__agStartedAt = startedAt;
        res.__agPayload = payload;
      } catch {
        /* frozen response object: timing is optional */
      }
      return res;
    }
    last = res;
    const rotate =
      res.status === 429 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 503 ||
      res.status === 500 ||
      res.status === 502;
    if (rotate) {
      // Record the wall even when there is nobody left to rotate to: this account
      // just said it cannot serve this model, and that fact is what stops the next
      // turn from walking into the same 429. A copy is read so the caller still
      // gets the original body to build its own message from.
      const text = await res.clone().text().catch(() => '');
      let coolUntil = resetHint(text);
      if (!coolUntil) {
        if (res.status === 403 && PERMANENT_403.test(text)) coolUntil = Date.now() + 6 * 3_600_000;
        else if (res.status >= 500) coolUntil = Date.now() + 60_000;
        else coolUntil = Date.now() + 120_000;
      }
      markCooling(account, model, coolUntil);
      if (index < candidates.length - 1) {
        log(`rotating past account ${account.id} for ${model}: upstream ${res.status}`);
        continue;
      }
    }
    break;
  }

  // If an aliased model (e.g. gemini-3.8-flash -> gemini-3.8-flash-tiered) ran out
  // of capacity or quota across the whole pool, step back once to the raw model id.
  if (
    last &&
    (last.status === 503 || last.status === 429) &&
    !body.__rawModel &&
    body.model &&
    isConfiguredAlias(body.model) &&
    resolveModel(body.model) !== body.model &&
    deadline - Date.now() >= 15_000
  ) {
    log(`all accounts exhausted for alias ${model}; falling back to raw model ${body.model}`);
    return upstream({ ...body, __rawModel: true }, signal, { totalBudgetMs: deadline - Date.now() });
  }
  return last;
}

/**
 * A stream that goes quiet mid-answer is dead, not slow. The header bound ends
 * where the answer starts, so the body guards itself: this is the budget for the
 * gap between two payloads, not for the whole turn.
 */
const STREAM_IDLE_MS = Number(process.env.AG_STREAM_IDLE_MS || 90_000);

/**
 * A thinking model streams nothing while it thinks, and `high` is 24576 tokens.
 * Keep this strictly below DSH's 300 s streamIdleTimeoutMs so the bridge's own
 * stalled-thought retry fires before the client kills the connection.
 */
const STREAM_IDLE_THINKING_MS = Number(process.env.AG_STREAM_IDLE_THINKING_MS || 180_000);

/** Silence allowed between payloads, which depends on whether the model is thinking. */
export function idleBudget(body) {
  const mode = body && body.__thinking;
  return mode === 'off' || mode === 'minimal' ? STREAM_IDLE_MS : STREAM_IDLE_THINKING_MS;
}

function readWithIdle(reader, idleMs) {
  let timer;
  const idle = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new DOMException('upstream stream idle timeout', 'TimeoutError')),
      idleMs,
    );
  });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}

/** Iterate the `data:` payloads of an SSE body. */
export async function* readSse(body, idleMs = STREAM_IDLE_MS) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = idleMs ? await readWithIdle(reader, idleMs) : await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const payload = ssePayload(line);
        if (payload !== null) yield payload;
      }
    }
    const tail = ssePayload(buffer.trim());
    if (tail !== null) yield tail;
  } finally {
    // Whoever stops reading early (idle timeout, client gone) must hand the
    // connection back instead of leaving a half-read body open.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function ssePayload(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  return payload;
}

export function parseSseJson(payload) {
  try {
    const json = JSON.parse(payload);
    return json.response || json;
  } catch {
    return null;
  }
}
