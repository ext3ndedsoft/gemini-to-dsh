/**
 * Runtime settings for the bridge: where it listens, how it authenticates, which
 * model aliases exist and where the thought-signature cache lives. Everything is
 * environment-first so a test or a second instance can be pointed elsewhere
 * without touching the code.
 */

import os from 'node:os';
import path from 'node:path';

export const HOST = process.env.AG_BRIDGE_HOST || '127.0.0.1';
export const PORT = Number(process.env.AG_BRIDGE_PORT || 8787);
export const SHARED_SECRET = process.env.AG_BRIDGE_SECRET || 'local-bridge';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_PROJECT = 'aicode-consumers';


export const SIGNATURE_FILE =
  process.env.AG_SIGNATURE_FILE || path.join(os.homedir(), '.dsh', 'ag-call-signatures.json');

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

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
