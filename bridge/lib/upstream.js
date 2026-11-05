/**
 * The Cloud Code side: request assembly, account rotation and the two service
 * calls the bridge exposes (/v1/models and the project id).
 */

import { noteRequest,
  accountMeta,
  accountModels,
  cloudPost,
  loadStore,
  markCooling,
  networkReason,
  orderedAccounts,
  primaryAccount,
  recordLatency,
} from '../accounts.js';
import { DEFAULT_PROJECT, log, resolveModel } from './config.js';
import { resetHint } from './http.js';
import { toContents } from './messages.js';
import { functionCallingConfig, thinkingConfig, toolDeclarations } from './schema.js';

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

export function buildRequest(body) {
  const { system, contents } = toContents(body.messages);

  // The caller's messages are translated as they are: no injected prologue, no
  // rewritten system instruction. What the client sends is what the model sees.
  const request = { contents };

  // toContents() collects every system/developer message into one list; Google
  // wants a single instruction block, so they are joined in order.
  if (system.length) request.systemInstruction = { parts: [{ text: system.join('\n\n') }] };

  const tools = toolDeclarations(body.tools);
  if (tools) {
    request.tools = tools;
    const toolConfig = functionCallingConfig(body.tool_choice);
    if (toolConfig) request.toolConfig = toolConfig;
  }

  const generationConfig = {};
  if (typeof body.temperature === 'number') generationConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') generationConfig.topP = body.top_p;
  if (typeof body.max_tokens === 'number') generationConfig.maxOutputTokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') generationConfig.maxOutputTokens = body.max_completion_tokens;
  if (Array.isArray(body.stop) && body.stop.length) generationConfig.stopSequences = body.stop.slice(0, 5);
  generationConfig.thinkingConfig = thinkingConfig(body.reasoning_effort, generationConfig.maxOutputTokens, body.__thinking);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  return { model: resolveModel(body.model), project: body.__project || null, request };
}

/**
 * One attempt, walking the account pool. A dead token or a quota/geo refusal on
 * one account must not fail the request while another account can still serve it.
 */
export async function upstream(body, signal) {
  const model = resolveModel(body.model);
  const forced = body.account ? loadStore().accounts.filter((acc) => acc.id === body.account) : [];
  const candidates = forced.length ? forced : orderedAccounts(model);
  if (!candidates.length) {
    throw Object.assign(new Error('no Antigravity accounts configured'), { status: 401 });
  }

  let last = null;
  // Assembled once: the body does not depend on the account, only the project id
  // does, and rebuilding it per candidate re-ran the schema/persona conversion for
  // every rotation and retry.
  const payload = buildRequest(body);
  for (let index = 0; index < candidates.length; index += 1) {
    const account = candidates[index];
    payload.project = (await getProject(account)) || DEFAULT_PROJECT;

    let res;
    const startedAt = Date.now();
    noteRequest(account);
    try {
      res = await cloudPost(account, '/v1internal:streamGenerateContent?alt=sse', payload, { signal });
    } catch (err) {
      // The failure is a measurement too: an account that hangs for the whole
      // header budget has earned its latency reading, or the ranking keeps putting
      // it first and the person keeps waiting 20 s before the failover.
      recordLatency(account, Date.now() - startedAt);
      log(`account ${account.id} threw for ${model} after ${Date.now() - startedAt}ms: ${networkReason(err)}`);
      markCooling(account, model, Date.now() + 300_000);
      if (index === candidates.length - 1) throw err;
      continue;
    }

    if (res.ok) {
      // The answer has not started until a payload arrives, so time-to-first-token
      // is recorded where it is read, not where the request is sent.
      try {
        res.__agAccount = account;
        res.__agStartedAt = startedAt;
      } catch {
        /* frozen response object: timing is optional */
      }
      return res;
    }
    last = res;
    const rotate = res.status === 429 || res.status === 401 || res.status === 403;
    if (rotate) {
      // Record the wall even when there is nobody left to rotate to: this account
      // just said it cannot serve this model, and that fact is what stops the next
      // turn from walking into the same 429. A copy is read so the caller still
      // gets the original body to build its own message from.
      const text = await res.clone().text().catch(() => '');
      markCooling(account, model, resetHint(text) || Date.now() + 120_000);
      if (index < candidates.length - 1) {
        log(`rotating past account ${account.id} for ${model}: upstream ${res.status}`);
        continue;
      }
    }
    return res;
  }
  return last;
}

/**
 * A stream that goes quiet mid-answer is dead, not slow. The header bound ends
 * where the answer starts, so the body guards itself: this is the budget for the
 * gap between two payloads, not for the whole turn.
 */
const STREAM_IDLE_MS = Number(process.env.AG_STREAM_IDLE_MS || 90_000);

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
