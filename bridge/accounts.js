/**
 * Multi-account layer for antigravity-bridge.
 *
 * Keeps a local pool of Google accounts that hold Antigravity entitlements,
 * refreshes their tokens, reads their model quota from Cloud Code, and ranks
 * them so a request goes to the account with the most headroom for that model.
 *
 * The account already present in ~/.gemini/oauth_creds.json is imported as the
 * `native` account and stays mirrored back into that file, so the Antigravity
 * IDE keeps working with the same session.
 */

import './dns-fix.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { UPSTREAM_TIMEOUT_MS } from './lib/config.js';
import { fetchQuotaSummary } from './lib/quota.js';
import { readConfig } from './egress.js';

export const API = 'https://daily-cloudcode-pa.googleapis.com';
export const USER_AGENT = 'antigravity/1.11.5 windows/amd64';
export const DEFAULT_PROJECT = 'aicode-consumers';

// OAuth client used to refresh the stored tokens. It is not a project credential:
// the same public installed-app client ships inside Google's own Gemini CLI, so it
// is read from the environment or from a local file and never carried in source.
const OAUTH_FILE = process.env.AG_OAUTH_FILE || path.join(os.homedir(), '.dsh', 'ag-oauth.json');
let oauthCache = null;

function oauth() {
  if (oauthCache) return oauthCache;
  if (process.env.AG_CLIENT_ID && process.env.AG_CLIENT_SECRET) {
    oauthCache = { id: process.env.AG_CLIENT_ID, secret: process.env.AG_CLIENT_SECRET };
    return oauthCache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const id = raw.client_id || raw.clientId || raw.id;
    const secret = raw.client_secret || raw.clientSecret || raw.secret;
    if (id && secret) {
      oauthCache = { id, secret };
      return oauthCache;
    }
  } catch {
    // absent or unreadable вЂ” explained to the caller below
  }
  throw new Error(
    `OAuth client is not configured: set AG_CLIENT_ID and AG_CLIENT_SECRET, or write ` +
      `{"client_id": "...", "client_secret": "..."} to ${OAUTH_FILE}`
  );
}

const clientId = () => oauth().id;
const clientSecret = () => oauth().secret;
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export const CREDS_FILE =
  process.env.AG_CREDS_FILE || path.join(os.homedir(), '.gemini', 'oauth_creds.json');
// The account pool lives beside the Google session, never inside the plugin
// folder: a backup or a published copy of the plugin must not carry refresh
// tokens with it. The bridge is started from several places (DSH supervisor, the
// logon task, start.cmd), so this default – not an env var – is what keeps all of
// them on the same file. Moving the credentials moves the pool with them.
const STORE_FILE =
  process.env.AG_ACCOUNTS_FILE ||
  path.join(path.dirname(CREDS_FILE), 'dsh-bridge', 'accounts.json');
// Builds before this one kept the pool inside the quota plugin. It is read once,
// then written under the new path so the tokens stop travelling with the plugin.
const LEGACY_STORE_FILE = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'web',
  'plugins',
  'ag-limits',
  'accounts.json',
);

const MODELS_TTL = 45_000;
const META_TTL = 3_600_000;

/** @type {{accounts: any[], pinned: string|null}|null} */
let store = null;
/** @type {Map<string, {at:number, models:any}>} */
const modelsCache = new Map();
/** @type {Map<string, number>} `${accountId}|${model}` -> epoch ms until which the account is skipped */
const cooldowns = new Map();
/** @type {Map<string, {ms:number, at:number}>} last measured time-to-first-token */
const latencies = new Map();
/** @type {Map<string, number>} upstream requests sent per account, since start */
const requestCounts = new Map();
/** @type {Map<string, Promise<any>>} */
const refreshing = new Map();
/** @type {Map<string, {verifier:string, at:number}>} */
const pendingLogins = new Map();

function log(...args) {
  console.log(new Date().toISOString(), '[accounts]', ...args);
}

// ------------------------------------------------------------------- storage

function saveStore() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  // Wall clocks ride along: "spent until the 12th" must not turn back into
  // "healthy" just because the bridge restarted, or every restart re-learns the
  // same dead account with another 429.
  const payload = { ...store, cooldowns: Object.fromEntries(cooldowns) };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function emailFromIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.split('.').length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

function readNativeCreds() {
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Mirror a native account's tokens back into the shared Antigravity credential file. */
function writeNativeCreds(acc) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch {}
  const next = {
    ...current,
    access_token: acc.access_token,
    refresh_token: acc.refresh_token || current.refresh_token,
    expiry_date: acc.expiry_date,
    token_type: current.token_type || 'Bearer',
    ...(acc.scope ? { scope: acc.scope } : {}),
  };
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  const tmp = CREDS_FILE + '.bridge.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CREDS_FILE);
}

function bootstrapNative() {
  const creds = readNativeCreds();
  if (!creds || (!creds.refresh_token && !creds.access_token)) return;
  let acc = store.accounts.find((a) => a.native);
  if (!acc) {
    acc = {
      id: 'native',
      email: emailFromIdToken(creds.id_token) || 'antigravity session',
      native: true,
      createdAt: Date.now(),
    };
    store.accounts.unshift(acc);
  }
  // The shared file wins only when it is strictly newer than what we hold: after
  // a bridge-side refresh our copy is authoritative and must not be clobbered.
  const fileNewer = !acc.expiry_date || (creds.expiry_date || 0) > acc.expiry_date;
  acc.refresh_token = creds.refresh_token || acc.refresh_token;
  if (fileNewer) {
    acc.access_token = creds.access_token || acc.access_token;
    acc.expiry_date = creds.expiry_date || acc.expiry_date;
  }
  saveStore();
}

export function loadStore() {
  if (store) return store;
  let parsed = null;
  let source = STORE_FILE;
  if (!fs.existsSync(source) && fs.existsSync(LEGACY_STORE_FILE)) source = LEGACY_STORE_FILE;
  try {
    // A BOM or a torn write must not silently wipe the pool: the file is copied
    // aside and the failure logged before starting from an empty store.
    const text = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try {
        fs.copyFileSync(source, `${source}.broken-${Date.now()}`);
      } catch {}
      log(`store unreadable (${err.message}); kept a copy and starting fresh`);
    }
  }
  store = {
    accounts: Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [],
    pinned: (parsed && parsed.pinned) || null,
    // Kept on the record so the five-hour guard survives a restart; dropping it
    // here silently reset the setting on every boot.
    ...(parsed && parsed.rotation ? { rotation: parsed.rotation } : {}),
  };
  const now = Date.now();
  for (const [key, at] of Object.entries((parsed && parsed.cooldowns) || {})) {
    if (typeof at === 'number' && at > now) cooldowns.set(key, at);
  }
  bootstrapNative();
  if (source !== STORE_FILE) {
    saveStore();
    log(`accounts: moved the pool from ${source} to ${STORE_FILE}`);
  }
  return store;
}

// -------------------------------------------------------------------- tokens

async function refreshAccount(acc) {
  if (!acc.refresh_token) {
    throw Object.assign(new Error(`account ${acc.id} has no refresh_token`), { status: 401 });
  }
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: acc.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`token refresh failed for ${acc.id}: ${json.error || res.status} ${json.error_description || ''}`.trim()),
      { status: res.status, account: acc.id },
    );
  }
  acc.access_token = json.access_token;
  acc.expiry_date = Date.now() + (json.expires_in || 3600) * 1000;
  if (json.scope) acc.scope = json.scope;
  saveStore();
  if (acc.native) writeNativeCreds(acc);
  return acc;
}

export async function accountToken(acc, { force = false } = {}) {
  const fresh = acc.expiry_date && acc.expiry_date - Date.now() > 120_000;
  if (!force && acc.access_token && fresh) return acc.access_token;
  if (!refreshing.has(acc.id)) {
    refreshing.set(
      acc.id,
      refreshAccount(acc).finally(() => refreshing.delete(acc.id)),
    );
  }
  const next = await refreshing.get(acc.id);
  return next.access_token;
}

// ---------------------------------------------------------------- cloud calls

/**
 * `fetch failed` is undici's wrapper around a socket-level failure; the reason
 * that actually matters lives on `.cause`. Without it the log says nothing.
 */
export function networkReason(err) {
  const code = err && err.cause && err.cause.code;
  return code ? `${err.message} (${code})` : String(err && err.message);
}

// The tunnel can die after the CONNECT succeeds вЂ” that is how the GeoHide legs
// fail, since a dead proxy still accepts TCP and only the TLS underneath falls
// over. Those are worth another go; a 4xx is not.
const RETRYABLE = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|other side closed|TLS|SSL/i;

/**
 * A stalled upstream used to sit silently forever: no headers, no error, nothing
 * in the log, and the client hung with it. Bound the wait for response headers so
 * a dead tier turns into a retry instead of a hang — and release the bound as soon
 * as the headers arrive: the very same signal aborts the body too, so holding it
 * for the whole call silently cut every answer that streamed longer than the
 * budget.
 */
export async function withHeaderTimeout(start, signal, timeoutMs) {
  if (!timeoutMs) return start(signal);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('upstream header timeout', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await start(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function cloudPost(acc, pathname, body, { signal, retries = 2, timeoutMs } = {}) {
  // A relay is any HTTPS base that forwards `/<path>` to the Cloud Code API, so a
  // Cloudflare Worker or a small VPS can carry the call when a local proxy is not
  // an option. Same paths, same headers, same streaming.
  // Cached read on purpose: forcing it here did a synchronous file read and a full
  // JSON parse on every upstream call, blocking the event loop mid-stream.
  const relay = String(readConfig().relay || '').replace(/\/$/, '');
  const call = (tok) =>
    withHeaderTimeout(
      (sig) =>
        fetch((relay || API) + pathname, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + tok,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: sig,
        }),
      signal,
      timeoutMs === undefined ? UPSTREAM_TIMEOUT_MS : timeoutMs,
    );

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) throw lastError || new Error('aborted');
    try {
      let res = await call(await accountToken(acc));
      if (res.status === 401) res = await call(await accountToken(acc, { force: true }));
      return res;
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err;
      lastError = err;
      // A cancelled turn must not be retried, and neither must a logic error.
      if ((signal && signal.aborted) || !RETRYABLE.test(networkReason(err))) throw err;
      if (attempt === retries) break;
      log(`cloudPost ${pathname} ${networkReason(err)} вЂ” retry ${attempt + 1}/${retries}`);
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Project id + subscription tier of one account, cached on the account record. */
export async function accountMeta(acc, { force = false } = {}) {
  if (!force && acc.project && acc.tier && Date.now() - (acc.metaAt || 0) < META_TTL) return acc;
  try {
    const res = await cloudPost(acc, '/v1internal:loadCodeAssist', {
      metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    });
    if (res.ok) {
      const json = await res.json();
      acc.project = json.cloudaicompanionProject || acc.project || DEFAULT_PROJECT;
      acc.tier = (json.paidTier && json.paidTier.id) || (json.currentTier && json.currentTier.id) || acc.tier;
      acc.tierName =
        (json.paidTier && json.paidTier.name) || (json.currentTier && json.currentTier.name) || acc.tierName;
      acc.metaAt = Date.now();
      saveStore();
    }
  } catch (err) {
    log(`loadCodeAssist failed for ${acc.id}: ${err.message}`);
  }
  return acc;
}

/** Raw fetchAvailableModels payload for one account, cached. */
export async function accountModels(acc, { force = false } = {}) {
  const cached = modelsCache.get(acc.id);
  if (!force && cached && Date.now() - cached.at < MODELS_TTL) return cached;
  await accountMeta(acc);
  const res = await cloudPost(acc, '/v1internal:fetchAvailableModels', acc.project ? { project: acc.project } : {});
  if (!res.ok) {
    throw Object.assign(new Error(`fetchAvailableModels ${res.status} for ${acc.id}`), { status: res.status });
  }
  const json = await res.json();
  const entry = { at: Date.now(), models: json.models || {} };
  modelsCache.set(acc.id, entry);
  return entry;
}

const INTERESTING = (id) => {
  if (id.startsWith('tab_') || id.startsWith('chat_')) return false;
  if (/gemini-[12](\.|$|-)/.test(id)) return false;
  return true;
};

/** Per-model remaining quota of one account, as fractions of the window. */
export async function accountQuota(acc, { force = false } = {}) {
  const entry = await accountModels(acc, { force });
  const models = {};
  for (const [id, info] of Object.entries(entry.models)) {
    if (!INTERESTING(id) || !info || !info.quotaInfo) continue;
    models[id] = {
      fraction: typeof info.quotaInfo.remainingFraction === 'number' ? info.quotaInfo.remainingFraction : 1,
      resetTime: info.quotaInfo.resetTime || null,
    };
  }
  return { at: entry.at, models };
}

// ------------------------------------------------------------------ selection

export function markCooling(acc, model, untilMs) {
  const until = Math.max(untilMs || Date.now() + 120_000, Date.now() + 15_000);
  cooldowns.set(`${acc.id}|${model}`, until);
  // A long wall is worth a write to the store: it has to survive a restart, or a
  // client goes back to calling a spent account healthy. A per-minute throttle is
  // not — persisting that would turn a retry loop into a disk loop.
  if (until - Date.now() > 30 * 60_000) saveStore();
}

/**
 * Worst five-hour bucket across the account's groups, 0..1, or null when it was
 * never fetched. The five-hour window is the one that runs out first during a long
 * session, so it is a better ranking signal than a single model's number.
 */
function fiveHourFraction(acc) {
  const cached = quotaSummaryCache.get(acc.id);
  const groups = cached && cached.value && cached.value.groups;
  if (!Array.isArray(groups)) return null;
  let worst = null;
  for (const group of groups) {
    for (const bucket of group.fiveHour || []) {
      const value = typeof bucket.remaining === 'number' ? bucket.remaining : bucket.remainingFraction;
      if (typeof value !== 'number') continue;
      worst = worst === null ? value : Math.min(worst, value);
    }
  }
  return worst;
}

function cooldownFor(acc, model) {
  return Math.max(cooldowns.get(`${acc.id}|${model}`) || 0, cooldowns.get(`${acc.id}|*`) || 0);
}

/**
 * Ranking value for one account: remaining headroom minus what its latency costs
 * in perceived quality. A 20 s stall is worse than a tank that is half empty — the
 * person waits either way, and the fast account should win while it still has
 * quota. Unknown latency costs nothing, so a fresh account gets tried.
 */
export function rankScore(fraction, latencyMs) {
  const penalty = Number.isFinite(latencyMs) ? Math.min(0.75, latencyMs / 40_000) : 0;
  return fraction - penalty;
}

/** Last measured first-token latency, ignored when it is older than half an hour. */
function freshLatency(id, now) {
  const seen = latencies.get(id);
  if (!seen || !Number.isFinite(seen.ms)) return null;
  if (now - (seen.at || 0) > 30 * 60_000) return null;
  return seen.ms;
}

/**
 * Accounts ranked for one model: not cooling first, then by remaining quota
 * headroom adjusted for speed, with the operator's pinned account promoted to the
 * front.
 */
export function orderedAccounts(model) {
  const current = loadStore();
  const now = Date.now();
  const scored = current.accounts
    .filter((acc) => acc.enabled !== false)
    .map((acc) => {
      const until = cooldownFor(acc, model);
      const quota = modelsCache.get(acc.id);
      const known = quota && quota.models && quota.models[model] && quota.models[model].quotaInfo;
      const modelFraction =
        known && typeof known.remainingFraction === 'number' ? known.remainingFraction : null;
      const fiveHour = fiveHourFraction(acc);
      // A known five-hour number wins: it is the window that actually blocks a
      // session. The per-model number still decides between accounts whose
      // five-hour reading is identical, and stands in when none was fetched.
      const fraction = fiveHour !== null ? fiveHour : modelFraction !== null ? modelFraction : 0.5;
      const latency = freshLatency(acc.id, now);
      return { acc, until, cooling: until > now, fraction, fiveHour, latency, score: rankScore(fraction, latency) };
    });
  const live = scored.filter((s) => !s.cooling).sort((a, b) => b.score - a.score);
  const waiting = scored.filter((s) => s.cooling).sort((a, b) => a.until - b.until);
  const ordered = [...live, ...waiting].map((s) => s.acc);
  const pinned = current.pinned;
  const rotation = rotationOf(current);
  if (pinned) {
    const index = ordered.findIndex((acc) => acc.id === pinned);
    const mine = scored.find((s) => s.acc.id === pinned);
    // The pin means "prefer this one", not "burn this one to zero while another
    // account sits above the floor". With the guard off, the pin simply wins.
    const floor = rotation.enabled && mine && mine.fiveHour !== null && mine.fiveHour <= rotation.threshold;
    if (index > 0 && !floor) ordered.unshift(...ordered.splice(index, 1));
    else if (index > 0) log(`accounts: ${pinned} is at ${Math.round(mine.fiveHour * 100)}% of its 5h window, not promoting it`);
  }
  return ordered;
}

/** Time to first token of a live request: what a person means by "how fast". */
export function recordLatency(acc, ms) {
  if (!acc || !Number.isFinite(ms) || ms <= 0) return;
  latencies.set(acc.id, { ms: Math.round(ms), at: Date.now() });
}

/** Every upstream call costs quota, including the ones that end badly. */
export function noteRequest(acc) {
  if (!acc) return;
  requestCounts.set(acc.id, (requestCounts.get(acc.id) || 0) + 1);
}

export function latencyOf(id) {
  return latencies.get(id) || null;
}

/**
 * Drop every cooldown this account collected. A switch that leaves the old
 * "wait five minutes" note behind is a switch the next request ignores.
 */
export function clearCooldowns(id) {
  for (const key of [...cooldowns.keys()]) {
    if (key.startsWith(id + '|')) cooldowns.delete(key);
  }
}

export function cooldownSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [key, until] of cooldowns) {
    if (until > now) {
      const [account, model] = key.split('|');
      out.push({ account, model, until });
    }
  }
  return out;
}

export function primaryAccount() {
  const current = loadStore();
  return orderedAccounts('*')[0] || current.accounts[0] || null;
}

/**
 * What the bridge itself has been told: this account is spent for these models
 * until that moment. The quota endpoints can report a healthy percentage while a
 * request is refused ("individual quota reached, resets in 6d"), so the panel has
 * to be able to show the observed truth, not only the reported estimate.
 */
export function limitedFor(id, now = Date.now()) {
  let until = 0;
  const models = [];
  for (const [key, at] of cooldowns) {
    if (at <= now || !key.startsWith(id + '|')) continue;
    if (at > until) until = at;
    const model = key.slice(id.length + 1);
    if (model !== '*' && !models.includes(model)) models.push(model);
  }
  return { limitedUntil: until || null, limitedModels: models };
}

// -------------------------------------------------------------- account CRUD

export function listAccounts() {
  const current = loadStore();
  return current.accounts.map((acc) => ({
    id: acc.id,
    email: acc.email || acc.id,
    native: Boolean(acc.native),
    enabled: acc.enabled !== false,
    pinned: current.pinned === acc.id,
    project: acc.project || null,
    tier: acc.tier || null,
    tierName: acc.tierName || null,
    hasToken: Boolean(acc.refresh_token),
    latency: latencies.get(acc.id) || null,
    requests: requestCounts.get(acc.id) || 0,
    ...limitedFor(acc.id),
  }));
}

const quotaSummaryCache = new Map(); // accountId -> { at, value }
const QUOTA_SUMMARY_TTL = 60 * 1000;

// Five percent of the five-hour window is the point where the next request is more
// likely to be refused than served, so the pinned account stops being promoted there.
const EXHAUSTED_AT = Number(process.env.AG_EXHAUSTED_AT || 0.05);

/** Cached grouped quota. Failures cache too, so a broken account cannot slow the whole panel. */
async function quotaSummary(acc, { force = false } = {}) {
  const cached = quotaSummaryCache.get(acc.id);
  if (!force && cached && Date.now() - cached.at < QUOTA_SUMMARY_TTL) return cached.value;
  try {
    const token = await accountToken(acc);
    const value = await fetchQuotaSummary({ token, project: acc.project });
    quotaSummaryCache.set(acc.id, { at: Date.now(), value });
    return value;
  } catch (err) {
    log('quota summary failed for ' + (acc.email || acc.id) + ': ' + err.message);
    quotaSummaryCache.set(acc.id, { at: Date.now(), value: null });
    return null;
  }
}

/**
 * Fill the five-hour cache without the panel: ordering by the 5h window is only
 * as fresh as the last /limits call, so a bridge nobody is watching would fall
 * back to "unknown" and never honour the 5% rule.
 */
export async function warmQuotaSummaries() {
  const current = loadStore();
  for (const account of current.accounts) {
    if (account.enabled === false) continue;
    const cached = quotaSummaryCache.get(account.id);
    if (cached && Date.now() - cached.at < QUOTA_SUMMARY_TTL) continue;
    await quotaSummary(account).catch(() => null);
  }
}

export async function limitsReport({ force = false } = {}) {
  const current = loadStore();
  const accounts = await Promise.all(
    current.accounts.map(async (acc) => {
      const row = {
        id: acc.id,
        email: acc.email || acc.id,
        native: Boolean(acc.native),
        pinned: current.pinned === acc.id,
        tier: acc.tier || null,
        tierName: acc.tierName || null,
        latency: latencies.get(acc.id) || null,
        requests: requestCounts.get(acc.id) || 0,
        ...limitedFor(acc.id),
      };
      try {
        const quota = await accountQuota(acc, { force });
        row.ok = true;
        row.project = acc.project || null;
        row.tier = acc.tier || null;
        row.tierName = acc.tierName || null;
        row.models = quota.models;
        row.at = quota.at;
        // Grouped windows (5h + weekly) live behind a separate endpoint and are optional.
        const [, summary] = await Promise.allSettled([null, quotaSummary(acc, { force })]);
        const summaryValue = summary.status === 'fulfilled' ? summary.value : null;
        row.groups = summaryValue ? summaryValue.groups : null;
        row.groupsAt = summaryValue ? summaryValue.at : null;
        row.groupsHost = summaryValue ? summaryValue.host : null;
      } catch (err) {
        row.ok = false;
        row.error = err.message;
      }
      return row;
    }),
  );
  return {
    accounts,
    pinned: current.pinned,
    rotation: rotationOf(current),
    cooldowns: cooldownSnapshot(),
    updatedAt: Date.now(),
  };
}

export function removeAccount(id) {
  const current = loadStore();
  const index = current.accounts.findIndex((acc) => acc.id === id);
  if (index < 0) return false;
  if (current.accounts[index].native) return false;
  current.accounts.splice(index, 1);
  if (current.pinned === id) current.pinned = null;
  modelsCache.delete(id);
  saveStore();
  return true;
}

const ROTATION_DEFAULTS = { enabled: true, threshold: EXHAUSTED_AT };

/**
 * The five-hour guard is a guess about somebody else's accounting, and it is
 * the one piece of routing that can stand between a person and a working
 * account. So it is a setting with an off switch, not a law.
 */
export function rotationOf(current = loadStore()) {
  const raw = current && current.rotation ? current.rotation : {};
  const threshold = Number(raw.threshold);
  return {
    enabled: raw.enabled !== false,
    threshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : ROTATION_DEFAULTS.threshold,
  };
}

export function setRotation(patch = {}) {
  const current = loadStore();
  const now = rotationOf(current);
  const next = {
    enabled: patch.enabled === undefined ? now.enabled : Boolean(patch.enabled),
    threshold: patch.threshold === undefined ? now.threshold : Math.min(1, Math.max(0, Number(patch.threshold))),
  };
  if (!Number.isFinite(next.threshold)) next.threshold = now.threshold;
  current.rotation = next;
  saveStore();
  log(`rotation: guard ${next.enabled ? 'on' : 'off'}, threshold ${Math.round(next.threshold * 100)}%`);
  return next;
}

export function setPinned(id) {
  const current = loadStore();
  if (id && !current.accounts.some((acc) => acc.id === id)) return false;
  current.pinned = id || null;
  saveStore();
  return true;
}

export function setEnabled(id, enabled) {
  const current = loadStore();
  const acc = current.accounts.find((a) => a.id === id);
  if (!acc) return false;
  if (acc.native && !enabled) return false;
  acc.enabled = Boolean(enabled);
  saveStore();
  return true;
}

// -------------------------------------------------------------------- OAuth

const REDIRECT_URI = () => `http://127.0.0.1:${process.env.AG_BRIDGE_PORT || 8787}/oauth/callback`;

export function startLogin() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  pendingLogins.set(state, { verifier, at: Date.now() });
  for (const [key, value] of pendingLogins) {
    if (Date.now() - value.at > 10 * 60_000) pendingLogins.delete(key);
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

export async function completeLogin(code, state) {
  const pending = pendingLogins.get(state);
  if (!pending) throw new Error('unknown or expired login state');
  pendingLogins.delete(state);
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    code_verifier: pending.verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI(),
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`code exchange failed: ${json.error || res.status} ${json.error_description || ''}`.trim());
  }
  const email = emailFromIdToken(json.id_token) || 'account ' + Date.now();
  const current = loadStore();
  const id = 'acc_' + crypto.createHash('sha1').update(email).digest('hex').slice(0, 8);
  let acc = current.accounts.find((a) => a.id === id);
  if (!acc) {
    acc = { id, email, native: false, createdAt: Date.now() };
    current.accounts.push(acc);
  }
  acc.email = email;
  acc.refresh_token = json.refresh_token || acc.refresh_token;
  acc.access_token = json.access_token;
  acc.expiry_date = Date.now() + (json.expires_in || 3600) * 1000;
  if (json.scope) acc.scope = json.scope;
  saveStore();
  modelsCache.delete(id);
  await accountMeta(acc, { force: true });
  await accountModels(acc, { force: true }).catch(() => {});
  return acc;
}