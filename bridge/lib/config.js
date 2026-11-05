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

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_PROJECT = 'aicode-consumers';


export const SIGNATURE_FILE =
  process.env.AG_SIGNATURE_FILE || path.join(os.homedir(), '.dsh', 'ag-call-signatures.json');

/** Which model draws pictures, where the files land, and whether plain words route to it. */
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
export const IMAGE_AUTO = process.env.AG_IMAGE_AUTO || '1';
export const IMAGE_PROVIDER = process.env.AG_IMAGE_PROVIDER || imageFile.provider || 'gemini';
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

export function resolveModel(requested) {
  const alias = MODEL_ALIASES.find(([from]) => from === requested);
  return alias ? alias[1] : requested;
}

/** How long the upstream may stay silent before an attempt counts as failed. */
export const UPSTREAM_TIMEOUT_MS = Number(process.env.AG_UPSTREAM_TIMEOUT_MS || 60000);

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
