/**
 * Bounded KV-cache keep-alive for active Gemini sessions.
 *
 * Cloud Code's implicit prefix cache expires after ~3-5 minutes of idle time,
 * forcing a full cold prefill (10-25s TTFT) on the next turn. Sending a tiny
 * 1-token ping with the same `request.sessionId` and prefix keeps the cache
 * warm while the user reads or types, then stops after a small cap so an
 * abandoned session never burns quota.
 *
 * AG_CACHE_KEEPALIVE=0 disables it.
 */

import crypto from 'node:crypto';
import { cloudPost, isCooling } from '../accounts.js';
import { log } from './config.js';

const ENABLED = process.env.AG_CACHE_KEEPALIVE !== '0';
const INTERVAL_MS = Math.max(30_000, Number(process.env.AG_CACHE_KEEPALIVE_MS || 45_000));
const MAX_PINGS = Math.max(0, Number(process.env.AG_CACHE_KEEPALIVE_MAX_PINGS || 6));
const MIN_TOKENS = Math.max(1024, Number(process.env.AG_CACHE_KEEPALIVE_MIN_TOKENS || 8192));
const PING_TIMEOUT_MS = Math.max(15_000, Number(process.env.AG_CACHE_KEEPALIVE_TIMEOUT_MS || 35_000));
const MAX_SESSIONS = 16;

/** sessionId -> { account, payload, pings, timer } */
const sessions = new Map();

export function buildPingPayload(payload) {
  const thinkingConfig = payload?.request?.generationConfig?.thinkingConfig;
  const generationConfig = { maxOutputTokens: 1 };
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  const requestType = payload?.requestType || 'agent';
  return {
    project: payload.project,
    requestId: `${requestType}/${crypto.randomUUID()}`,
    model: payload.model,
    ...(payload.userPromptId ? { userPromptId: payload.userPromptId } : {}),
    userAgent: payload.userAgent || 'antigravity',
    requestType,
    request: {
      ...payload.request,
      generationConfig,
    },
  };
}

async function drainUsage(res) {
  const text = await res.text().catch(() => '');
  let usage = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw);
      const inner = parsed.response || parsed;
      if (inner.usageMetadata) usage = inner.usageMetadata;
    } catch {
      /* ignore malformed chunk */
    }
  }
  return usage;
}

function armTimer(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    runPing(sessionId).catch(() => {});
  }, INTERVAL_MS);
  entry.timer.unref?.();
}

async function runPing(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.timer = null;
  if (entry.pings >= MAX_PINGS) {
    sessions.delete(sessionId);
    return;
  }
  const { account, payload } = entry;
  if (!account || account.enabled === false || isCooling(account, payload.model)) {
    sessions.delete(sessionId);
    return;
  }
  entry.pings += 1;
  const pingNum = entry.pings;
  try {
    const res = await cloudPost(account, '/v1internal:streamGenerateContent?alt=sse', buildPingPayload(payload), {
      signal: AbortSignal.timeout(PING_TIMEOUT_MS + 5_000),
      retries: 0,
      timeoutMs: PING_TIMEOUT_MS,
    });
    if (!res.ok) {
      await res.text().catch(() => '');
      log(`cache-keepalive: ${sessionId} (${payload.model}) ping ${pingNum}/${MAX_PINGS} HTTP ${res.status}`);
      if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      return;
    }
    const usage = await drainUsage(res);
    // If a real turn arrived while the ping was in flight, do not re-arm.
    if (sessions.get(sessionId) !== entry) return;
    const cached = usage?.cachedContentTokenCount || 0;
    const prompt = usage?.promptTokenCount || 0;
    log(`cache-keepalive: ${sessionId} (${payload.model}) ping ${pingNum}/${MAX_PINGS} cached=${cached}/${prompt}`);
    if (entry.pings < MAX_PINGS) armTimer(sessionId);
    else sessions.delete(sessionId);
  } catch (err) {
    if (sessions.get(sessionId) !== entry) return;
    log(`cache-keepalive: ${sessionId} (${payload.model}) ping ${pingNum}/${MAX_PINGS} failed: ${err?.message || err}`);
    if (entry.pings < MAX_PINGS) armTimer(sessionId);
    else sessions.delete(sessionId);
  }
}

export function cancelKeepAlive(sessionId) {
  if (!sessionId) return;
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(sessionId);
}

export function scheduleKeepAlive({ account, payload, usage } = {}) {
  if (!ENABLED || MAX_PINGS <= 0) return;
  const sessionId = payload?.request?.sessionId;
  if (!sessionId || !account || !payload?.model) return;
  if (!/^gemini-/i.test(payload.model)) return;
  const promptTokens = usage?.promptTokenCount || 0;
  const cachedTokens = usage?.cachedContentTokenCount || 0;
  if (promptTokens < MIN_TOKENS && cachedTokens === 0) return;

  cancelKeepAlive(sessionId);
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    cancelKeepAlive(oldest);
  }
  sessions.set(sessionId, { account, payload, pings: 0, timer: null });
  armTimer(sessionId);
}

export function stopAllKeepAlives() {
  for (const sessionId of [...sessions.keys()]) cancelKeepAlive(sessionId);
}
