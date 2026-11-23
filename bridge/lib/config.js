/**
 * Runtime settings for the bridge: where it listens, how it authenticates, which
 * model aliases exist and where the thought-signature cache lives. Everything is
 * environment-first so a test or a second instance can be pointed elsewhere
 * without touching the code.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOST = process.env.AG_BRIDGE_HOST || '127.0.0.1';
export const PORT = Number(process.env.AG_BRIDGE_PORT || 8787);
export const SHARED_SECRET = process.env.AG_BRIDGE_SECRET || 'local-bridge';

/**
 * The Antigravity client identity Google sees. Too old a version is refused outright
 * ("This version of Antigravity is no longer supported"), so this is one number that
 * both the generation and the quota calls have to agree on.
 */
export const CLIENT_VERSION = process.env.AG_CLIENT_VERSION || '2.34.0';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_SEARCH_MODEL = process.env.AG_SEARCH_MODEL || 'gemini-3.5-flash-lite';
export const SEARCH_FALLBACK_MODEL = process.env.AG_SEARCH_FALLBACK_MODEL || 'gemini-2.5-flash-lite';
export const SEARCH_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.8-flash-tiered',
];
export const DEFAULT_PROJECT = 'aicode-consumers';

export const SIGNATURE_FILE =
  process.env.AG_SIGNATURE_FILE || path.join(os.homedir(), '.dsh', 'ag-call-signatures.json');

/**
 * Where pictures are drawn, kept in ~/.dsh/image-provider.json so a paid API key never
 * lands in the repository. `gemini` rides the Cloud Code transport and needs no key;
 * `openai` is any service that speaks POST /v1/images/generations.
 */
const imageFile = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'image-provider.json'), 'utf8'));
  } catch {
    return {};
  }
})();

export const DEFAULT_IMAGE_MODEL =
  process.env.AG_IMAGE_MODEL || imageFile.model || 'gemini-3.1-flash-image';
export const IMAGE_DIR = process.env.AG_IMAGE_DIR || path.join(os.homedir(), '.dsh', 'images');
export const IMAGE_AUTO = process.env.AG_IMAGE_AUTO || (imageFile.auto === false ? '0' : '1');
export const IMAGE_PROVIDER = process.env.AG_IMAGE_PROVIDER || imageFile.provider || 'gemini';
export const FALLBACK_IMAGE_MODEL = imageFile.model || 'gpt-image-2.5-sunburst';
export const IMAGE_BASE_URL = (process.env.AG_IMAGE_BASE_URL || imageFile.baseUrl || '').replace(/\/+$/, '');
export const IMAGE_API_KEY = process.env.AG_IMAGE_API_KEY || imageFile.apiKey || '';
export const IMAGE_SIZE = process.env.AG_IMAGE_SIZE || imageFile.size || 'auto';
export const IMAGE_QUALITY = process.env.AG_IMAGE_QUALITY || imageFile.quality || '';

/** `from=to,from2=to2` — lets the caller use a short name the UI knows. */
export const MODEL_ALIASES = (process.env.AG_MODEL_ALIASES || `${DEFAULT_MODEL}=${DEFAULT_MODEL}-tiered`)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => entry.split('=').map((side) => side.trim()));

/**
 * Hub-gated model families whose upstream catalog splits each reasoning tier
 * into its own model id (`-low`, `-medium`, `-high`, `-xhigh`). Mapping the
 * family name by `reasoning_effort` lets clients expose one model entry with an
 * effort selector.
 */
const EFFORT_FAMILIES = {
  'gemini-4-neon': {
    base: 'gemini-4-neon',
    levels: { off: 'low', none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', extra: 'xhigh', max: 'xhigh' },
    fallback: 'high',
  },
  'gemini-4-argon': {
    base: 'gemini-4-argon',
    levels: { off: 'low', none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', extra: 'high', max: 'high' },
    fallback: 'medium',
  },
  'gemini-4-hydrogen': {
    base: 'gemini-4-hydrogen',
    levels: { off: 'low', none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', extra: 'xhigh', max: 'xhigh' },
    fallback: 'medium',
  },
  'claude-opus-5-5': {
    base: 'claude-opus-5-5',
    levels: { off: 'low', none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', extra: 'high', max: 'high' },
    fallback: 'medium',
  },
  'claude-sonnet-5-5': {
    base: 'claude-sonnet-5-5',
    levels: { off: 'low', none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', extra: 'high', max: 'high' },
    fallback: 'medium',
  },
};

export const VIRTUAL_MODELS = [
  ['gemini-4-neon', 'gemini-4-neon-high'],
  ['gemini-4-argon', 'gemini-4-argon-medium'],
  ['gemini-4-hydrogen', 'gemini-4-hydrogen-medium'],
];

export function isConfiguredAlias(requested) {
  return MODEL_ALIASES.some(([from]) => from === requested);
}

export function resolveModel(requested, options = {}) {
  // `raw` skips the alias table: used when a caller deliberately steps back to
  // the model it asked for after an alias target ran out of capacity.
  if (options.raw) return requested;
  const alias = MODEL_ALIASES.find(([from]) => from === requested);
  if (alias) return alias[1];
  const family = EFFORT_FAMILIES[requested];
  if (family) {
    const effort = String(options.effort || '').toLowerCase();
    const suffix = family.levels[effort] || family.fallback;
    return `${family.base}-${suffix}`;
  }
  if (!requested || requested.includes('deepseek') || requested.includes('openrouter') || requested.includes('/')) {
    const defaultAlias = MODEL_ALIASES.find(([from]) => from === DEFAULT_MODEL);
    return defaultAlias ? defaultAlias[1] : DEFAULT_MODEL;
  }
  return requested;
}

/** How long the upstream may stay silent before an attempt counts as failed.
 *
 * This is the budget from request to first byte, and it is the one that punishes a
 * long task hardest: a prompt with a full session of tool output behind it spends
 * longer than a minute inside the model before the first token comes out. Timing
 * that out cools a perfectly good account for five minutes and fails the turn.
 */
export const UPSTREAM_TIMEOUT_MS = Number(process.env.AG_UPSTREAM_TIMEOUT_MS || 120000);

/** Total budget across account failover in one upstream() call, kept below DSH's 300s watchdog. */
export const UPSTREAM_TOTAL_MS = Number(process.env.AG_UPSTREAM_TOTAL_MS || 200000);

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
