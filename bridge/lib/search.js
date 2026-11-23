/**
 * Web search over Cloud Code's built-in Google Search grounding (`googleSearch`).
 *
 * Mirrors Antigravity's own `search_web` path: sends a fast Gemini model a
 * single `generateContent` call with `tools: [{ googleSearch: {} }]`, extracts
 * the grounded summary, search queries, and `groundingChunks` joined with
 * `groundingSupports` snippets, and resolves Google's redirect URLs to real
 * destinations.
 */

import crypto from 'node:crypto';
import {
  accountMeta,
  cloudPost,
  loadStore,
  markCooling,
  networkReason,
  noteRequest,
  orderedAccounts,
  recommendedSearchModel,
  recordLatency,
  searchModelOf,
} from '../accounts.js';
import {
  DEFAULT_PROJECT,
  DEFAULT_SEARCH_MODEL,
  SEARCH_FALLBACK_MODEL,
  log,
} from './config.js';
import { errorStatus, resetHint, upstreamErrorText } from './http.js';

const SEARCH_TIMEOUT_MS = Number(process.env.AG_SEARCH_TIMEOUT_MS || 25_000);
const REDIRECT_TIMEOUT_MS = Number(process.env.AG_SEARCH_REDIRECT_MS || 2_500);
const REDIRECT_HOST = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;
const PERMANENT_403 = /disabled in this account|violation of Terms of Service|Verify your account/i;
const SEARCH_SYSTEM_PROMPT =
  'You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.';

/** Resolve Google's grounding redirect URL to its real destination, falling back to the original URI. */
export async function resolveRedirectUrl(uri, signal) {
  if (typeof uri !== 'string' || !REDIRECT_HOST.test(uri)) return uri;
  const timeout = AbortSignal.timeout(REDIRECT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(uri, { method, redirect: 'manual', signal: combined });
      if (method === 'HEAD' && (res.status === 405 || res.status === 501)) {
        await res.body?.cancel?.().catch(() => {});
        continue;
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      await res.body?.cancel?.().catch(() => {});
      if (location) {
        const resolved = new URL(location, uri);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString();
      }
      return uri;
    } catch {
      return uri;
    }
  }
  return uri;
}

/** Extract grounded answer text, search queries, and chunk+snippet pairs from a Cloud Code response. */
export function parseSearchResponse(json) {
  const response = json?.response || json || {};
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();

  const gm = candidate?.groundingMetadata || {};
  const queries = Array.isArray(gm.webSearchQueries)
    ? gm.webSearchQueries.filter((q) => typeof q === 'string' && q.trim())
    : [];

  const snippetsByChunk = new Map();
  for (const support of Array.isArray(gm.groundingSupports) ? gm.groundingSupports : []) {
    const text = typeof support?.segment?.text === 'string' ? support.segment.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    for (const idx of Array.isArray(support.groundingChunkIndices) ? support.groundingChunkIndices : []) {
      if (!Number.isInteger(idx)) continue;
      let list = snippetsByChunk.get(idx);
      if (!list) {
        list = [];
        snippetsByChunk.set(idx, list);
      }
      if (!list.includes(text)) list.push(text);
    }
  }

  const rawSources = [];
  const chunks = Array.isArray(gm.groundingChunks) ? gm.groundingChunks : [];
  for (let i = 0; i < chunks.length; i += 1) {
    const web = chunks[i]?.web;
    const url = typeof web?.uri === 'string' ? web.uri.trim() : '';
    if (!url) continue;
    const title = typeof web?.title === 'string' ? web.title.trim() : '';
    const snippet = (snippetsByChunk.get(i) || []).join(' ').slice(0, 400);
    rawSources.push({ url, title, snippet });
  }

  return { content, queries, rawSources };
}

/** Resolve redirect URLs in parallel, deduplicate by final URL, and cap to `maxResults`. */
export async function finalizeSources(rawSources, maxResults = 8, { signal, resolveUrl = resolveRedirectUrl } = {}) {
  const limit = Math.max(1, Math.min(20, Number(maxResults) || 8));
  const resolved = await Promise.all(
    (rawSources || []).map(async (item) => {
      const url = await resolveUrl(item.url, signal);
      return { ...item, url };
    }),
  );

  const byUrl = new Map();
  for (const item of resolved) {
    if (!item.url || !/^https?:\/\//i.test(item.url)) continue;
    const existing = byUrl.get(item.url);
    if (!existing) {
      byUrl.set(item.url, {
        url: item.url,
        title: item.title || item.url,
        snippet: item.snippet || '',
      });
      continue;
    }
    if (item.title && (!existing.title || existing.title === existing.url)) existing.title = item.title;
    if (item.snippet && !existing.snippet.includes(item.snippet)) {
      existing.snippet = existing.snippet ? `${existing.snippet} ${item.snippet}`.slice(0, 400) : item.snippet;
    }
  }

  const all = [...byUrl.values()];
  return {
    sources: all.slice(0, limit),
    truncated: all.length > limit,
  };
}

async function runSearchAttempt(targetModel, query, deadline, signal) {
  const candidates = orderedAccounts(targetModel);
  if (!candidates.length) {
    throw Object.assign(new Error('no Antigravity accounts configured'), { status: 401 });
  }

  const payload = {
    project: DEFAULT_PROJECT,
    requestId: `web_search/${crypto.randomUUID()}`,
    model: targetModel,
    userAgent: 'antigravity',
    requestType: 'web_search',
    request: {
      systemInstruction: {
        role: 'user',
        parts: [{ text: SEARCH_SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: query }],
        },
      ],
      tools: [{ googleSearch: {} }],
    },
  };

  let lastRes = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const remaining = deadline - Date.now();
    if (index > 0 && remaining < 5_000) break;
    const account = candidates[index];
    const meta = await accountMeta(account).catch(() => null);
    payload.project = (meta && meta.project) || DEFAULT_PROJECT;

    const startedAt = Date.now();
    noteRequest(account);
    let res;
    try {
      res = await cloudPost(account, '/v1internal:generateContent', payload, {
        signal,
        retries: 1,
        timeoutMs: Math.max(5_000, remaining),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      recordLatency(account, Date.now() - startedAt);
      log(`search: account ${account.id} threw for ${targetModel}: ${networkReason(err)}`);
      markCooling(account, targetModel, Date.now() + 300_000);
      if (index === candidates.length - 1) {
        if (lastRes) return { res: lastRes, account };
        throw err;
      }
      continue;
    }

    if (res.ok) {
      recordLatency(account, Date.now() - startedAt);
      return { res, account };
    }

    lastRes = res;
    const rotate =
      res.status === 429 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 503 ||
      res.status === 500 ||
      res.status === 502;
    if (rotate) {
      const text = await res.clone().text().catch(() => '');
      let coolUntil = resetHint(text);
      if (!coolUntil) {
        if (res.status === 403 && PERMANENT_403.test(text)) coolUntil = Date.now() + 6 * 3_600_000;
        else if (res.status >= 500) coolUntil = Date.now() + 60_000;
        else coolUntil = Date.now() + 120_000;
      }
      markCooling(account, targetModel, coolUntil);
      if (index < candidates.length - 1) {
        log(`search: rotating past ${account.id} for ${targetModel}: upstream ${res.status}`);
        continue;
      }
    }
    break;
  }
  return { res: lastRes, account: null };
}

/** Run a grounded Google Search query through Cloud Code and return normalized sources + summary. */
export async function searchWeb({ query, maxResults = 8, model } = {}, { signal, resolveUrl } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw Object.assign(new Error('query must be a non-empty string'), { status: 400 });
  if (!loadStore().accounts.length) {
    throw Object.assign(new Error('no Antigravity accounts configured'), { status: 401 });
  }

  const startedAt = Date.now();
  const deadline = startedAt + SEARCH_TIMEOUT_MS;
  const explicit = typeof model === 'string' && model.trim() && model.trim().toLowerCase() !== 'auto' ? model.trim() : '';
  const configured = searchModelOf();
  let usedModel = explicit || configured || process.env.AG_SEARCH_MODEL || recommendedSearchModel() || DEFAULT_SEARCH_MODEL;
  let attempt = await runSearchAttempt(usedModel, q, deadline, signal);

  if (
    (!attempt.res || !attempt.res.ok) &&
    !explicit &&
    usedModel !== SEARCH_FALLBACK_MODEL &&
    deadline - Date.now() >= 8_000
  ) {
    usedModel = SEARCH_FALLBACK_MODEL;
    attempt = await runSearchAttempt(usedModel, q, deadline, signal);
  }

  if (!attempt.res) {
    throw Object.assign(new Error('search upstream returned no response'), { status: 502 });
  }
  if (!attempt.res.ok) {
    const { message, status } = await upstreamErrorText(attempt.res);
    throw Object.assign(new Error(message.slice(0, 800) || `upstream ${status}`), {
      status: errorStatus(status),
      code: `upstream_${status}`,
    });
  }

  const json = await attempt.res.json();
  const parsed = parseSearchResponse(json);
  const { sources, truncated } = await finalizeSources(parsed.rawSources, maxResults, { signal, resolveUrl });
  log(`search: model=${usedModel} sources=${sources.length} queries=${parsed.queries.length} (${Date.now() - startedAt}ms)`);

  return {
    ...(parsed.content ? { content: parsed.content } : {}),
    sources,
    queries: parsed.queries,
    model: usedModel,
    truncated,
  };
}
