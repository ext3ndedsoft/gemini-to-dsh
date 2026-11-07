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
import { newCallId, rememberCall, flushSignatures } from './signatures.js';
import { ThinkingStream } from './thinking.js';
import { recordLatency } from '../accounts.js';
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
  // 'close' on the request fires the moment the body has been read — long before
  // the answer exists — so it used to cancel nothing. The response is the object
  // that actually outlives the turn.
  res.on('close', () => controller.abort());

  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || DEFAULT_MODEL;
  const counters = { content: 0, reasoning: 0, toolCalls: 0 };
  let callIndex = -1;
  let sentRole = false;
  let finish = null;
  let usage = null;
  let wrote = false;
  /** Signature of the whole response: the model signs only its first call. */
  let groupSignature;
  /** Calls of this response that still have no signature, awaiting the group's. */
  let unsigned = [];
  /** The upstream body died mid-answer: the turn is incomplete, not finished. */
  let interrupted = false;

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
  res.on('close', () => pacer.stop());

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
    const args = call.functionCall.args || {};
    // Gemini signs only the first call of a parallel group. Since a client may
    // replay each call on its own, the group's signature is carried by all of
    // them: the same reasoning covers the whole response.
    const signature = call.thoughtSignature || groupSignature;
    rememberCall(callId, signature, call.functionCall.name, args);
    if (!signature) unsigned.push({ id: callId, name: call.functionCall.name, args });
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
            arguments: JSON.stringify(args),
          },
        },
      ],
    });
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const prepared = retryBody(body, attempt);
    const suppressReasoning = Boolean(prepared.__suppressReasoning);
    const splitter = new ThinkingStream();
    groupSignature = undefined;
    unsigned = [];

    let upstreamRes;
    try {
      upstreamRes = await upstream(prepared, controller.signal);
    } catch (err) {
      // The client pressed Stop before upstream answered: nothing is owed to a
      // connection that is already gone, and a 502 would only be logged against it.
      if (controller.signal.aborted) return;
      if (counters.content || counters.toolCalls) break;
      return openAiError(res, 502, 'upstream request failed: ' + err.message);
    }

    if (!upstreamRes.ok) {
      const { message, status } = await upstreamErrorText(upstreamRes);
      const last = attempt === MAX_ATTEMPTS - 1;
      // A 4xx is deterministic: retrying a region rejection, a bad model id or a
      // rejected schema three times only triples how long the failure takes. A 429
      // is stronger than deterministic — upstream() has already walked the whole
      // account pool for this model, so the wall is somebody else's quota, not a
      // hiccup. Retrying it re-sends the entire prompt for another 429.
      const retryable = status >= 500;
      if (!retryable || counters.content || counters.toolCalls || last) {
        pacer.flush();
        return openAiError(res, errorStatus(status), message.slice(0, 800) || 'upstream error', 'upstream_' + status);
      }
      log(`upstream ${status} on attempt ${attempt + 1} for ${model}; retrying degraded`);
      // Back off a little: a relay that just answered 502 in 40 ms is usually
      // healthy again a second later, and an instant retry lands in the same hole.
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }

    let failed = false;
    let timed = false;
    let sawFinish = false;
    finish = null;
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
        if (candidate.finishReason) {
          finish = candidate.finishReason;
          sawFinish = true;
        }

        for (const part of (candidate.content && candidate.content.parts) || []) {
          // A signature can arrive on its own part, or on a later part than the
          // call itself. Either way it belongs to every call of this response.
          if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
            if (!groupSignature) groupSignature = part.thoughtSignature;
            for (const pending of unsigned) {
              rememberCall(pending.id, groupSignature, pending.name, pending.args);
            }
            unsigned = [];
          }
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
      log('stream interrupted: ' + err.message);
      failed = true;
      interrupted = true;
    }

    for (const piece of splitter.flush()) {
      if (piece.kind === 'reasoning') {
        // Reasoning released after the answer started would reorder the turn.
        if (!suppressReasoning && !counters.content) emitReasoning(piece.text);
      } else {
        emitContent(piece.text);
      }
    }

    // A stream that ends without a finish reason was cut, not completed: the
    // final chunk is where upstream says how the turn ended. Treating a lost tail
    // as a normal stop is how half an answer becomes the stored answer.
    if (!failed && !sawFinish) {
      log('upstream stream ended without a finish reason; treating it as interrupted');
      failed = true;
      interrupted = true;
    }

    if (failed) break;
    if (counters.content || counters.toolCalls) break;
    if (attempt === MAX_ATTEMPTS - 1) break;
    log(`empty answer for ${model} (attempt ${attempt + 1}); retrying with thinking reduced`);
  }

  // Nothing may still be queued when the closing chunk goes out, or the tail of
  // the answer would arrive after finish_reason and be dropped by the client.
  pacer.flush();
  flushSignatures();

  // Reasoning is not an answer. A client that receives thoughts and then a
  // finish_reason "stop" renders a step that said nothing, treats the turn as
  // complete and stops the agent loop there — the task looks finished while
  // nothing was produced. When nothing visible came out, an error is the honest
  // result, even if reasoning already reached the wire.
  const answered = counters.content > 0 || counters.toolCalls > 0;
  if (!wrote || !answered) {
    if (interrupted) {
      return openAiError(
        res,
        502,
        'upstream stream was interrupted before any answer',
        'stream_interrupted'
      );
    }
    if (counters.reasoning > 0) {
      log(`upstream produced ${counters.reasoning} chars of reasoning and no answer; reporting a failure`);
    }
    return openAiError(res, 502, 'upstream returned an empty answer', 'empty_upstream_response');
  }

  if (interrupted) {
    // Half an answer is not an answer: say so, instead of ending the turn with
    // finish_reason "stop" and letting the client store a cut sentence as final.
    log(`stream interrupted after ${counters.content} answer chars; reporting it to the client`);
    return openAiError(
      res,
      502,
      'upstream stream was interrupted; the answer above is incomplete',
      'stream_interrupted'
    );
  }

  // Only STOP is a normal end. Dressing a safety block or a broken tool call up as
  // "stop" hands the client a turn that looks finished while nothing came out.
  if (finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') {
    log(`upstream could not build a valid tool call (${finish}); reporting it to the client`);
    return openAiError(
      res,
      502,
      `upstream could not build a valid tool call (${finish})`,
      'upstream_function_call_failed'
    );
  }

  // A truncated turn is a truncated turn even when what survived looks like a tool
  // call: reporting tool_calls here hides a cut-off argument list from the client.
  const FILTERED = {
    SAFETY: 1,
    RECITATION: 1,
    BLOCKLIST: 1,
    PROHIBITED_CONTENT: 1,
    SPII: 1,
    IMAGE_SAFETY: 1,
    OTHER: 1,
  };
  const finishReason =
    finish === 'MAX_TOKENS'
      ? 'length'
      : FILTERED[finish]
        ? 'content_filter'
        : counters.toolCalls > 0
          ? 'tool_calls'
          : 'stop';
  const finalChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (usage) finalChunk.usage = usagePayload(usage);
  if (usage) {
    // The number that explains a burnt weekly limit, in the one place where it is
    // visible: what this turn actually cost upstream.
    log(
      `usage: in=${usage.promptTokenCount || 0} out=${usage.candidatesTokenCount || 0}` +
        ` think=${usage.thoughtsTokenCount || 0} cached=${usage.cachedContentTokenCount || 0}`,
    );
  }
  sseHead(res);
  res.write('data: ' + JSON.stringify(finalChunk) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
