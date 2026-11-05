/**
 * Image generation over the same Cloud Code transport.
 *
 * Two things live here and nothing else:
 *
 *  - a saved picture, because a chat client cannot show base64 and a turn that
 *    "succeeded" with an empty answer is indistinguishable from a broken one;
 *  - intent routing, so asking any model for a picture reaches the image model
 *    without a slash-command. The check runs on the last user message only, and
 *    a request that already names an image model skips it entirely.
 *
 * The image backend is one exported function (`generate`). Swapping Gemini for an
 * API-key provider means replacing that function, not the callers: they only see
 * `{ files, text }`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_IMAGE_MODEL, IMAGE_API_KEY, IMAGE_AUTO, IMAGE_BASE_URL, IMAGE_DIR, IMAGE_PROVIDER, IMAGE_QUALITY, IMAGE_SIZE, log } from './config.js';
import { parseSseJson, readSse, upstream } from './upstream.js';

// `\b` is ASCII-only in JS, so the Cyrillic half is written without boundaries:
// those stems are long enough that a false hit is not realistic.
const MAKE_EN = /\b(?:draw|paint|generate|create|make|render|sketch|design|illustrate|edit|retouch|redraw)\b/i;
const MAKE_RU = /(?:нарисуй|нарисуйте|нарисуешь|сгенерируй|сгенерируйте|сгенерь|создай|сделай|построй|отредактируй|перерисуй|дорисуй)/i;
/** A verb strong enough to stand alone: "нарисуй кота" has no noun from the list. */
const STRONG = /\b(?:draw|paint|render|sketch)\b|(?:нарисуй|нарисуйте|нарисуешь|сгенерируй|сгенерируйте|сгенерь|перерисуй|дорисуй)/i;
const THING_EN = /\b(?:image|picture|photo|photograph|art|artwork|illustration|drawing|render|logo|poster|avatar|wallpaper|icon|sticker|meme|thumbnail)\b/i;
const THING_RU = /(?:картинк|изображени|фотк|фото|арт(?:[^а-яё]|$)|иллюстрац|рисун|логотип|аватарк|аватар|обложк|постер|стикер|мем)/i;
/** Reading a picture is the other half of the same vocabulary and must not route. */
const READ = /\b(?:describe|analyse|analyze|recognize|identify|explain|read|compare|what'?s in|what is in|look at)\b|(?:опиши|опишите|проанализируй|распознай|объясни|что на|что изображено|сравни|прочитай)/i;

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    return '';
  }
  return '';
}

function hasImageInput(messages) {
  for (const message of messages || []) {
    if (!message || !Array.isArray(message.content)) continue;
    if (message.content.some((part) => part && part.type === 'image_url')) return true;
  }
  return false;
}

/** True when the sentence asks for a picture to be produced. */
export function wantsImage(text) {
  if (!text || text.length > 4000) return false;
  const makes = MAKE_EN.test(text) || MAKE_RU.test(text);
  if (!makes) return false;
  if (THING_EN.test(text) || THING_RU.test(text)) return true;
  return STRONG.test(text);
}

export function isImageModel(model, config = {}) {
  const target = (config.imageModel || DEFAULT_IMAGE_MODEL || '').toLowerCase();
  const id = String(model || '').toLowerCase();
  if (!id) return false;
  if (target && id === target) return true;
  return /(?:^|[-_/])image(?:$|[-_/])/.test(id);
}

/**
 * `direct` — the client asked for the image model by name.
 * `auto`   — a text model was asked to draw something.
 * Otherwise null, and the normal path runs untouched.
 */
export function routeFor(body, config = {}) {
  if (isImageModel(body && body.model, config)) return 'direct';
  if (IMAGE_AUTO === '0') return null;
  const text = lastUserText(body && body.messages);
  if (!wantsImage(text)) return null;
  // A question about an attached picture is a reading task, not a drawing task.
  if (hasImageInput(body.messages) && READ.test(text)) return null;
  return 'auto';
}

function extensionFor(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/gif': 'gif',
  };
  return map[mime] || 'png';
}

export function imageDir() {
  const dir = IMAGE_DIR || path.join(os.homedir(), '.dsh', 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes the picture and returns its absolute path. */
export function saveImage(mime, base64) {
  const dir = imageDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = crypto.randomBytes(3).toString('hex');
  const file = path.join(dir, `img-${stamp}-${suffix}.${extensionFor(mime)}`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

function imageMarkdown(file) {
  return `![generated image](${file.replace(/\\/g, '/')})`;
}

/** The text a client sees: any prose the model added, then the pictures. */
export function answerText(files, text) {
  const lines = [];
  if (text && text.trim()) lines.push(text.trim());
  if (!text || !text.trim()) lines.push(`Generated ${files.length === 1 ? 'an image' : files.length + ' images'}.`);
  for (const file of files) lines.push(imageMarkdown(file));
  return lines.join('\n\n');
}

/**
 * Any service that speaks POST /v1/images/generations. The key never lives in the
 * repository: it comes from the environment or ~/.dsh/image-provider.json.
 */
export async function generateViaApi(body, { signal, model } = {}) {
  if (!IMAGE_BASE_URL || !IMAGE_API_KEY) {
    throw Object.assign(
      new Error(
        'image provider is not configured: set AG_IMAGE_BASE_URL and AG_IMAGE_API_KEY, or write {baseUrl, apiKey} to ~/.dsh/image-provider.json'
      ),
      { status: 500 }
    );
  }

  const prompt = lastUserText(body && body.messages).trim();
  if (!prompt) throw Object.assign(new Error('nothing to draw: the request has no text'), { status: 400 });

  const request = { model: model || DEFAULT_IMAGE_MODEL, prompt, n: 1, size: IMAGE_SIZE };
  if (IMAGE_QUALITY) request.quality = IMAGE_QUALITY;

  const response = await fetch(`${IMAGE_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${IMAGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      message = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || message;
      if (typeof message === 'object') message = JSON.stringify(message).slice(0, 300);
    } catch {
      /* plain text is fine */
    }
    throw Object.assign(new Error(`${request.model} answered ${response.status}: ${message}`), {
      status: response.status,
    });
  }

  const json = await response.json();
  const item = (json.data || [])[0] || {};
  const files = [];

  if (item.b64_json) {
    files.push(saveImage('image/png', item.b64_json));
  } else if (item.url) {
    const bin = await fetch(item.url, { signal });
    if (!bin.ok) throw Object.assign(new Error(`could not download the picture: ${bin.status}`), { status: 502 });
    files.push(saveImage(bin.headers.get('content-type') || 'image/png', Buffer.from(await bin.arrayBuffer()).toString('base64')));
  } else {
    throw Object.assign(new Error('the image provider returned neither b64_json nor url'), { status: 502 });
  }

  log(`image: ${request.model} via api produced ${files.length} file(s) -> ${files.join(', ')}`);
  return { files, text: '', upstreamText: '' };
}

/**
 * Calls the image model and collects what came back.
 * Returns `{ files, text, upstreamText }` — `upstreamText` is kept for logs only.
 */
export async function generate(body, { signal, model } = {}) {
  if (IMAGE_PROVIDER === 'openai') return generateViaApi(body, { signal, model });
  const target = model || DEFAULT_IMAGE_MODEL;
  const request = {
    ...body,
    model: target,
    // The image model takes no tools and no tool choice; passing them through
    // makes the transport reject the request instead of drawing anything.
    tools: undefined,
    tool_choice: undefined,
  };

  const response = await upstream(request, signal);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`image model ${target} answered ${response.status}: ${text.slice(0, 300)}`), {
      status: response.status,
    });
  }

  const collected = [];
  const parts = [];
  for await (const payload of readSse(response.body)) {
    const parsed = parseSseJson(payload);
    if (!parsed) continue;
    const candidate = parsed.candidates && parsed.candidates[0];
    if (!candidate) continue;
    for (const part of (candidate.content && candidate.content.parts) || []) {
      if (part.inlineData && part.inlineData.data) {
        collected.push({ mime: part.inlineData.mimeType || 'image/png', data: part.inlineData.data });
        continue;
      }
      if (typeof part.text === 'string' && part.thought !== true) parts.push(part.text);
    }
  }

  // The transport sends the same finished frame more than once, re-encoded: the
  // bytes differ, the picture does not. Byte-identical hashes miss that, equal
  // decoded size within 2% catches it, and a genuine second variant is bigger or
  // smaller than that.
  const files = [];
  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i];
    const duplicate = collected.findIndex((other, j) => {
      if (j <= i) return false;
      const bigger = Math.max(current.data.length, other.data.length);
      return Math.abs(current.data.length - other.data.length) / bigger < 0.02;
    });
    if (duplicate === -1) files.push(saveImage(current.mime, current.data));
  }

  const text = parts.join('').trim();
  log(`image: ${target} produced ${files.length} file(s)${files.length ? ' -> ' + files.join(', ') : ''}`);
  return { files, text, upstreamText: text };
}