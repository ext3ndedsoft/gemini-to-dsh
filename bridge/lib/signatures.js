/**
 * Gemini 3 wants the thought signature of a function call to travel back with it
 * when the call is replayed in history; OpenAI messages carry only the call id.
 * Keeping that map in memory alone means the very first replay after a bridge
 * restart has no signatures left and the model answers nothing, so it is also
 * mirrored to disk — small, debounced, and never allowed to take the process down.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SIGNATURE_FILE, log } from './config.js';

const MAX_ENTRIES = 4000;
const SAVE_DELAY_MS = 400;

const calls = new Map();
let loaded = false;
let saveTimer = null;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(SIGNATURE_FILE, 'utf8'));
    for (const [id, value] of Object.entries(parsed || {})) {
      if (value && typeof value === 'object') calls.set(id, { signature: value.signature, name: value.name });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log(`signature cache unreadable (${err.message}); starting empty`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSignatures();
  }, SAVE_DELAY_MS);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

export function saveSignatures() {
  if (!calls.size) return;
  try {
    const payload = {};
    let index = 0;
    // Keep the newest entries: Map preserves insertion order.
    for (const [id, value] of calls) {
      index += 1;
      if (index <= calls.size - MAX_ENTRIES) continue;
      payload[id] = value;
    }
    fs.mkdirSync(path.dirname(SIGNATURE_FILE), { recursive: true });
    const temp = `${SIGNATURE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload));
    fs.renameSync(temp, SIGNATURE_FILE);
  } catch (err) {
    log(`signature cache write failed: ${err.message}`);
  }
}

export function rememberCall(id, signature, name) {
  if (!id) return;
  load();
  calls.set(id, { signature, name });
  while (calls.size > MAX_ENTRIES) calls.delete(calls.keys().next().value);
  if (signature) scheduleSave();
}

export function signatureFor(id) {
  load();
  const entry = id && calls.get(id);
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
