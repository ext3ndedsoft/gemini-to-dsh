/**
 * Gemini 3 wants the thought signature of a function call to travel back with it
 * when the call is replayed in history; OpenAI messages carry only the call id.
 * Keeping that map in memory alone means the very first replay after a bridge
 * restart has no signatures left, so it is also mirrored to disk — small,
 * debounced, and never allowed to take the process down.
 *
 * Three ways to lose a signature all end in the same 400 ("Function call is
 * missing a thought_signature"), so all three are covered here: the model signs
 * only the first call of a parallel group, a signature can arrive late or on its
 * own part, and a client is free to rewrite the call id it echoes back. The id is
 * therefore not the only key: the function name plus a canonical form of its
 * arguments identifies the call just as well.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SIGNATURE_FILE, log } from './config.js';

const MAX_ENTRIES = 4000;
/**
 * In memory a signature is worth keeping whatever its size — replaying a call
 * without one is a hard 400, not a degraded answer. Only the disk copy needs a
 * ceiling, so the entry limit below applies to the file and never drops a live
 * signature. (Measured here: 1832 calls, 3.75 MB, largest single entry 83 KB.)
 */
const MAX_BYTES = 512 * 1024;
const DISK_ENTRY_BYTES = 16 * 1024;

/**
 * Documented escape hatch from Gemini's thought-signature docs: this value tells
 * the API to skip validation for the part. It exists for traces that come from a
 * different model — which is exactly what a client that rewrote our call ids looks
 * like from the outside.
 */
export const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';

const calls = new Map();
/** `${name}|${hash}` -> call id, so a renamed id still finds its own signature. */
const byArgs = new Map();
let loaded = false;
let dirty = false;

/** Stable JSON so a reformatted argument list hashes the same, deep enough to matter. */
function canonical(value, depth = 0) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (depth > 6) return '"…"';
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}

/** Accepts either the argument object we got from upstream or the string a client replays. */
export function canonicalArgs(argsOrText) {
  if (typeof argsOrText === 'string') {
    try {
      return canonical(JSON.parse(argsOrText));
    } catch {
      return argsOrText;
    }
  }
  return canonical(argsOrText || {});
}

function argsKey(name, argsOrText) {
  if (!name) return null;
  const digest = crypto.createHash('sha1').update(canonicalArgs(argsOrText)).digest('hex').slice(0, 16);
  return `${name}|${digest}`;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(SIGNATURE_FILE, 'utf8'));
    for (const [id, value] of Object.entries(parsed || {})) {
      if (!value || typeof value !== 'object') continue;
      const signature = typeof value.signature === 'string' && value.signature ? value.signature : undefined;
      const entry = { signature, name: value.name, h: typeof value.h === 'string' ? value.h : undefined };
      calls.set(id, entry);
      if (entry.h && entry.name) byArgs.set(`${entry.name}|${entry.h}`, id);
    }
    while (calls.size > MAX_ENTRIES) calls.delete(calls.keys().next().value);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`signature cache unreadable (${err.message}); starting empty`);
  }
}

/**
 * Written once per turn, not once per tool call: the debounce used to stringify
 * and write the whole 0.5 MB cache in the middle of a streaming answer.
 */
export function flushSignatures() {
  if (!dirty) return;
  dirty = false;
  saveSignatures();
}

export function saveSignatures() {
  if (!calls.size) return;
  try {
    // Newest first, then stop at the byte ceiling: Map preserves insertion order,
    // so walking backwards keeps the signatures that are still in play. An entry
    // over the disk limit stays in memory and is simply not persisted.
    const keep = [];
    let bytes = 2;
    const entries = [...calls.entries()].reverse();
    for (const [id, value] of entries) {
      const size = JSON.stringify(value).length;
      if (size > DISK_ENTRY_BYTES) continue;
      if (bytes + size > MAX_BYTES) break;
      bytes += size + id.length + 6;
      keep.push([id, value]);
    }
    keep.reverse();
    const payload = JSON.stringify(Object.fromEntries(keep));
    fs.mkdirSync(path.dirname(SIGNATURE_FILE), { recursive: true });
    const temp = `${SIGNATURE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, payload);
    fs.renameSync(temp, SIGNATURE_FILE);
  } catch (err) {
    log(`signature cache write failed: ${err.message}`);
  }
}

/**
 * Record the signature of one call. Passing no signature still creates the entry:
 * the id is kept so a signature that arrives later in the same response, or the
 * signature of its parallel sibling, can fill it in.
 */
export function rememberCall(id, signature, name, argsOrText) {
  if (!id) return;
  load();
  const previous = calls.get(id);
  const usable = typeof signature === 'string' && signature ? signature : previous && previous.signature;
  const key = argsKey(name || (previous && previous.name), argsOrText);
  const entry = {
    signature: usable,
    name: name || (previous && previous.name),
    h: key ? key.slice(key.indexOf('|') + 1) : previous && previous.h,
  };
  calls.set(id, entry);
  if (key) byArgs.set(key, id);
  // The index has to die with the entry it points at, otherwise it keeps a key for
  // every call this process ever saw and outgrows the map it is supposed to serve.
  while (calls.size > MAX_ENTRIES) {
    const oldest = calls.keys().next().value;
    const evicted = calls.get(oldest);
    if (evicted && evicted.name && evicted.h) byArgs.delete(`${evicted.name}|${evicted.h}`);
    calls.delete(oldest);
  }
  while (byArgs.size > MAX_ENTRIES) byArgs.delete(byArgs.keys().next().value);
  if (usable) dirty = true;
}

export function signatureFor(id) {
  load();
  const entry = id && calls.get(id);
  return entry && entry.signature;
}

/**
 * The signature for a replayed call: by id first, then by name and arguments, which
 * survives a client that re-minted the id while re-serialising history.
 */
export function signatureForCall(id, name, argsOrText) {
  const direct = signatureFor(id);
  if (direct) return direct;
  load();
  const key = argsKey(name, argsOrText);
  const owner = key && byArgs.get(key);
  const entry = owner && calls.get(owner);
  return entry && entry.signature;
}

export function nameForCall(id) {
  load();
  const entry = id && calls.get(id);
  return entry && entry.name;
}

export function newCallId() {
  return 'call_' + crypto.randomBytes(9).toString('hex');
}