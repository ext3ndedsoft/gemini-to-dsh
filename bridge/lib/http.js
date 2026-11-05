/** HTTP plumbing: body parsing, JSON/SSE responses, error envelopes, page mode. */

import crypto from 'node:crypto';

export function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload) {
  // The client may have walked away while the answer was being prepared; writing
  // into a dead response throws where a silent return is the honest behaviour.
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function openAiError(res, status, message, code = 'upstream_error') {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: { message, type: 'invalid_request_error', code } });
}

export function sseHead(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function chunkId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

export function isLocal(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function htmlPage(res, status, title, detail) {
  const esc = (value) =>
    String(value == null ? '' : value).replace(
      /[&<>"]/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
    );
  const body = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:14px/1.5 system-ui;background:#14141a;color:#e8e8ea;padding:48px"><h1 style="font-size:18px">${esc(title)}</h1><p style="opacity:.75">${esc(detail)}</p><p style="opacity:.5">gemini-to-dsh-bridge</p>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * Pull the reset moment out of an upstream quota error. Google phrases it two
 * ways: an ISO `resetTime` field, or a sentence — "Individual quota reached.
 * ... Resets in 156h57m47s." The sentence is the one that matters: it is the
 * weekly wall, and reading it wrong means hammering a dead account every two
 * minutes for the rest of the week.
 */
export function resetHint(text) {
  const raw = String(text || '');
  const iso = /"reset(?:Time|_time)"\s*:\s*"([^"]+)"/i.exec(raw);
  if (iso) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return at;
  }
  const sentence =
    /resets? in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i.exec(
      raw,
    );
  if (sentence) {
    const ms =
      Number(sentence[1] || 0) * 86_400_000 +
      Number(sentence[2] || 0) * 3_600_000 +
      Number(sentence[3] || 0) * 60_000 +
      Number(sentence[4] || 0) * 1000;
    if (ms > 0) return Date.now() + ms;
  }
  return null;
}

/**
 * A relay that dies answers with its own nginx page. That HTML is useless to the
 * client and unreadable in a chat, so it becomes one sentence that says what
 * happened and who is to blame.
 */
function readableFailure(text) {
  if (!/^\s*</.test(text || '')) return text;
  const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  const server = (text.match(/\b(nginx|cloudflare|openresty|envoy|Caddy)\b[\s/]*[\d.]*/i) || [])[0];
  const head = (title || 'an HTML error page').trim();
  return `the egress relay answered with ${head}${server ? ` (${server})` : ''} — nothing upstream is down, the channel is`;
}

/** Unwrap `{error:{message}}` so the client sees Google's sentence, not the JSON. */
export async function upstreamErrorText(res) {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text);
    return { message: (parsed.error && parsed.error.message) || text, status: res.status };
  } catch {
    return { message: readableFailure(text), status: res.status };
  }
}

/** 429 stays 429 (clients back off), 5xx becomes 502, everything else is a 400. */
export function errorStatus(status) {
  return status === 429 ? 429 : status >= 500 ? 502 : 400;
}

export function usagePayload(usage) {
  if (!usage) return null;
  const prompt = usage.promptTokenCount || 0;
  const completion = usage.candidatesTokenCount || 0;
  // Upstream reports its implicit cache separately. Dropping the field made every
  // client show a 0% cache hit even when the prompt was served from cache.
  const cached = usage.cachedContentTokenCount || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokenCount || prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount || 0 },
  };
}
