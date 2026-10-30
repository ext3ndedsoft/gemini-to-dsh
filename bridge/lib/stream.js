/**
 * Streaming translation Cloud Code SSE -> OpenAI chat.completion.chunk.
 *
 * Two behaviours here exist because the model itself is unreliable, not because
 * the wire format is:
 *
 *  - an "answer" that carries only whitespace or only thoughts is not an answer,
 *    so it is never forwarded as one (an empty block is what made the agent loop
 *    end a turn with nothing on screen);
 *  - when a turn really is empty, it is retried with thinking reduced and finally
 *    reported as an error, so a dead turn is visible instead of silent.
 */

import { DEFAULT_MODEL, log } from './config.js';
import { chunkId, errorStatus, openAiError, sseHead, upstreamErrorText, usagePayload } from './http.js';
import { Pacer } from './pacer.js';
import { newCallId, rememberCall } from './signatures.js';
import { ThinkingStream } from './thinking.js';
import { parseSseJson, readSse, upstream } from './upstream.js';

export const MAX_ATTEMPTS = 3;
const EMPTY_NUDGE = 'Your previous reply was empty. Call a tool now, or answer the user in text.';

/** A degraded copy of the request used only when the previous attempt said nothing. */
export function retryBody(body, attempt) {
  if (attempt === 0) return body;
  const messages = [...(body.messages || [])];
  if (attempt > 1) messages.push({ role: 'system', content: EMPTY_NUDGE });
  return { ...body, messages, __thinking: 'minimal', __suppressReasoning: true };
}

export async function handleStream(req, res, body) {
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || DEFAULT_MODEL;
  const counters = { content: 0, reasoning: 0, toolCalls: 0 };
  let callIndex = -1;
  let sentRole = false;
  let finish = null;
  let usage = null;
  let wrote = false;

  const emit = (delta, finishReason = null) => {
    sseHead(res);
    wrote = true;
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  };

  const startRole = () => {
    if (sentRole) return;
    sentRole = true;
    emit({ role: 'assistant', content: '' });
  };

  // Text is paced, everything else is not: reasoning arrives as a couple of huge
  // blocks and stretching those would delay the answer by seconds.
  const pacer = new Pacer((text) => {
    if (res.writableEnded || res.destroyed) return;
    emit({ content: text });
  });
  // A vanished client must not leave a timer writing into a dead response.
  req.on('close', () => pacer.stop());

  const emitContent = (text) => {
    if (!text) return;
    startRole();
    counters.content += text.length;
    pacer.push(text);
  };

  /** Reasoning goes out the moment it arrives: holding it made a whole thinking phase invisible. */
  const emitReasoning = (text) => {
    if (!text) return;
    startRole();
    counters.reasoning += text.length;
    emit({ reasoning_content: text });
  };

  const emitCall = (call) => {
    const callId = call.functionCall.id || newCallId();
    rememberCall(callId, call.thoughtSignature, call.functionCall.name);
    startRole();
    callIndex += 1;
    counters.toolCalls += 1;
    emit({
      tool_calls: [
        {
          index: callIndex,
          id: callId,
          type: 'function',
          function: {
            name: call.functionCall.name,
            arguments: JSON.stringify(call.functionCall.args || {}),
          },
        },
      ],
    });
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const prepared = retryBody(body, attempt);
    const suppressReasoning = Boolean(prepared.__suppressReasoning);
    const splitter = new ThinkingStream();

    let upstreamRes;
    try {
      upstreamRes = await upstream(prepared, controller.signal);
    } catch (err) {
      if (counters.content || counters.toolCalls) break;
      return openAiError(res, 502, 'upstream request failed: ' + err.message);
    }

    if (!upstreamRes.ok) {
      const { message, status } = await upstreamErrorText(upstreamRes);
      const last = attempt === MAX_ATTEMPTS - 1;
      // A 4xx is deterministic: retrying a region rejection, a bad model id or a
      // rejected schema three times only triples how long the failure takes.
      const retryable = status === 429 || status >= 500;
      if (!retryable || counters.content || counters.toolCalls || last) {
        pacer.flush();
        return openAiError(res, errorStatus(status), message.slice(0, 800) || 'upstream error', 'upstream_' + status);
      }
      log(`upstream ${status} on attempt ${attempt + 1} for ${model}; retrying degraded`);
      continue;
    }

    let failed = false;
    try {
      for await (const payload of readSse(upstreamRes.body)) {
        const response = parseSseJson(payload);
        if (!response) continue;
        if (response.usageMetadata) usage = response.usageMetadata;
        const candidate = response.candidates && response.candidates[0];
        if (!candidate) continue;
        if (candidate.finishReason) finish = candidate.finishReason;

        for (const part of (candidate.content && candidate.content.parts) || []) {
          if (part.functionCall) {
            emitCall(part);
            continue;
          }
          if (typeof part.text !== 'string') continue;
          if (part.thought === true) {
            if (suppressReasoning || !part.text.trim()) continue;
            emitReasoning(part.text);
            continue;
          }
          for (const piece of splitter.push(part.text)) {
            if (piece.kind === 'reasoning') {
              if (!suppressReasoning) emitReasoning(piece.text);
            } else {
              emitContent(piece.text);
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      log('stream aborted: ' + err.message);
      failed = true;
    }

    for (const piece of splitter.flush()) {
      if (piece.kind === 'reasoning') {
        // Reasoning released after the answer started would reorder the turn.
        if (!suppressReasoning && !counters.content) emitReasoning(piece.text);
      } else {
        emitContent(piece.text);
      }
    }

    if (failed) break;
    if (counters.content || counters.toolCalls) break;
    if (attempt === MAX_ATTEMPTS - 1) break;
    log(`empty answer for ${model} (attempt ${attempt + 1}); retrying with thinking reduced`);
  }

  // Nothing may still be queued when the closing chunk goes out, or the tail of
  // the answer would arrive after finish_reason and be dropped by the client.
  pacer.flush();

  if (!wrote) {
    return openAiError(res, 502, 'upstream returned an empty answer', 'empty_upstream_response');
  }

  // A truncated turn is a truncated turn even when what survived looks like a tool
  // call: reporting tool_calls here hides a cut-off argument list from the client.
  const finishReason = finish === 'MAX_TOKENS' ? 'length' : counters.toolCalls > 0 ? 'tool_calls' : 'stop';
  const finalChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (usage) finalChunk.usage = usagePayload(usage);
  sseHead(res);
  res.write('data: ' + JSON.stringify(finalChunk) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
