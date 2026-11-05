/**
 * Non-streaming translation, sharing the retry ladder with the streaming path so
 * both wire formats behave the same when the model answers nothing.
 */

import { DEFAULT_MODEL, log } from './config.js';
import { chunkId, errorStatus, openAiError, sendJson, upstreamErrorText, usagePayload } from './http.js';
import { newCallId, rememberCall, flushSignatures } from './signatures.js';
import { MAX_ATTEMPTS, retryBody } from './stream.js';
import { splitThinking } from './thinking.js';
import { recordLatency } from '../accounts.js';
import { parseSseJson, readSse, upstream } from './upstream.js';

export async function handleOnce(req, res, body) {
  const model = body.model || DEFAULT_MODEL;
  // A cancelled client must not keep paying for the upstream call. 'close' on the
  // request fires as soon as the body has been read, so the response is the object
  // that actually lives for the length of the turn.
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let finish = 'STOP';
  let usage = null;
  /** An upstream body that died mid-answer: retried, and named in the final error. */
  let interrupted = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const prepared = retryBody(body, attempt);
    const suppressReasoning = Boolean(prepared.__suppressReasoning);
    // Each attempt reports its own numbers: a retry must not inherit the usage or
    // the finish reason of the attempt that answered nothing.
    usage = null;
    finish = 'STOP';

    let upstreamRes;
    try {
      upstreamRes = await upstream(prepared, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      return openAiError(res, 502, 'upstream request failed: ' + err.message);
    }

    if (!upstreamRes.ok) {
      const { message, status } = await upstreamErrorText(upstreamRes);
      const last = attempt === MAX_ATTEMPTS - 1;
      // Same rule as the streaming path: only a transient status is worth retrying.
      const retryable = status === 429 || status >= 500;
      if (!retryable || text || toolCalls.length || last) {
        return openAiError(res, errorStatus(status), message.slice(0, 800) || 'upstream error', 'upstream_' + status);
      }
      log(`upstream ${status} on attempt ${attempt + 1} for ${model}; retrying degraded`);
      // Back off a little: a relay that just answered 502 in 40 ms is usually
      // healthy again a second later, and an instant retry lands in the same hole.
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }

    text = '';
    reasoning = '';
    let timed = false;
    toolCalls.length = 0;

    try {
      for await (const payload of readSse(upstreamRes.body)) {
        if (!timed && upstreamRes.__agAccount) {
          timed = true;
          recordLatency(upstreamRes.__agAccount, Date.now() - upstreamRes.__agStartedAt);
        }
        const response = parseSseJson(payload);
        if (!response) continue;
        if (response.usageMetadata) usage = response.usageMetadata;
        const candidate = response.candidates && response.candidates[0];
        if (!candidate) continue;
        if (candidate.finishReason) finish = candidate.finishReason;

        for (const part of (candidate.content && candidate.content.parts) || []) {
          if (part.functionCall) {
            const callId = part.functionCall.id || newCallId();
            rememberCall(callId, part.thoughtSignature, part.functionCall.name);
            toolCalls.push({
              id: callId,
              type: 'function',
              function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
            });
            continue;
          }
          if (typeof part.text !== 'string') continue;
          if (part.thought === true) {
            if (!suppressReasoning && part.text.trim()) reasoning += part.text;
            continue;
          }
          const split = splitThinking(part.text);
          text += split.content;
          if (split.reasoning && !suppressReasoning) reasoning += split.reasoning;
        }
      }
    } catch (err) {
      // Nothing has been sent to the client yet, so a half-read body is thrown away
      // and the attempt is retried instead of being reported as an answer.
      if (controller.signal.aborted) return;
      log('stream interrupted: ' + err.message);
      interrupted = true;
      text = '';
      reasoning = '';
      toolCalls.length = 0;
      if (attempt === MAX_ATTEMPTS - 1) break;
      continue;
    }

    if (text || toolCalls.length) break;
    if (attempt === MAX_ATTEMPTS - 1) break;
    log(`empty answer for ${model} (attempt ${attempt + 1}); retrying with thinking reduced`);
  }

  if (!text && !toolCalls.length) {
    return openAiError(
      res,
      502,
      interrupted ? 'upstream stream was interrupted before any answer' : 'upstream returned an empty answer',
      interrupted ? 'stream_interrupted' : 'empty_upstream_response'
    );
  }

  flushSignatures();

  sendJson(res, 200, {
    id: chunkId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : finish === 'MAX_TOKENS' ? 'length' : 'stop',
      },
    ],
    usage: usagePayload(usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
