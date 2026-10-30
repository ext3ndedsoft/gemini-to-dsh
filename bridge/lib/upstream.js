/**
 * The Cloud Code side: request assembly, account rotation and the two service
 * calls the bridge exposes (/v1/models and the project id).
 */

import {
  accountMeta,
  accountModels,
  cloudPost,
  loadStore,
  markCooling,
  networkReason,
  orderedAccounts,
  primaryAccount,
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
  for (let index = 0; index < candidates.length; index += 1) {
    const account = candidates[index];
    const payload = buildRequest(body);
    payload.project = (await getProject(account)) || DEFAULT_PROJECT;

    let res;
    try {
      res = await cloudPost(account, '/v1internal:streamGenerateContent?alt=sse', payload, { signal });
    } catch (err) {
      log(`account ${account.id} threw for ${model}: ${networkReason(err)}`);
      markCooling(account, model, Date.now() + 300_000);
      if (index === candidates.length - 1) throw err;
      continue;
    }

    if (res.ok) return res;
    last = res;
    const rotate = res.status === 429 || res.status === 401 || res.status === 403;
    if (!rotate || index === candidates.length - 1) return res;

    const text = await res.text().catch(() => '');
    const until = resetHint(text) || Date.now() + 120_000;
    markCooling(account, model, until);
    log(`rotating past account ${account.id} for ${model}: upstream ${res.status}`);
  }
  return last;
}

/** Iterate the `data:` payloads of an SSE body. */
export async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
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
