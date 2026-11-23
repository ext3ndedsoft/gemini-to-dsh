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
import { scheduleKeepAlive } from './cache-keepalive.js';
import { chunkId, errorStatus, openAiError, sseHead, upstreamErrorText, usagePayload } from './http.js';
import { Pacer } from './pacer.js';
import { sanitizeToolArgs } from './schema.js';
import { newCallId, rememberCall, flushSignatures } from './signatures.js';
import { ThinkingStream } from './thinking.js';
import { recordLatency } from '../accounts.js';
import { idleBudget, parseSseJson, readSse, upstream } from './upstream.js';

export const MAX_ATTEMPTS = 3;
const EMPTY_NUDGE = 'Your previous reply was empty. Call a tool now, or answer the user in text.';
/** Reasoning held back at the start of a turn, see emitReasoning(). Default 0 so thoughts stream immediately. */
const rawReasoningHold = Number(process.env.AG_REASONING_HOLD ?? 0);
const REASONING_HOLD = Number.isFinite(rawReasoningHold) && rawReasoningHold >= 0 ? rawReasoningHold : 0;
/** Max time to hold initial reasoning before flushing so slow turns stay visible and keep the client watchdog alive. */
const REASONING_HOLD_MS = Number(process.env.AG_REASONING_HOLD_MS || 10_000);
/** Keep total silent wait inside one HTTP request below DSH's 300 s streamIdleTimeoutMs. */
const CLIENT_WATCHDOG_MS = Number(process.env.AG_CLIENT_WATCHDOG_MS || 260_000);
const KEEPALIVE_MS = 15_000;

/**
 * A transport cut in the middle of an answer is continued instead of being thrown
 * away. Long turns are exactly the ones a relay or an edge drops, and a failed turn
 * on minute nine costs more than the whole retry ladder.
 */
const RESUME_ATTEMPTS = Number(process.env.AG_RESUME_ATTEMPTS || 2);

/** Tail of the answer kept as the anchor a continuation has to pick up from. */
const RESUME_ANCHOR = 160;

const CONTINUE_NOTE =
  'The transport cut the previous reply off mid-sentence. Continue it from the exact point where it ' +
  'stopped, in the same language, tone and formatting. Do not repeat anything already written, do not ' +
  'restart the reply, and do not mention the interruption.';

/** The request that continues an answer the transport cut in half. */
export function continuationBody(body, tail) {
  const messages = [...(body.messages || [])];
  messages.push({ role: 'assistant', content: tail });
  messages.push({ role: 'user', content: CONTINUE_NOTE });
  return { ...body, messages, __suppressReasoning: true };
}

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
  /** Answer-not-yet-known: clears the moment a real answer or tool call starts. */
  let held = '';
  let heldLive = false;
  let heldTimer = null;
  /** Signature of the whole response: the model signs only its first call. */
  let groupSignature;
  /** Calls of this response that still have no signature, awaiting the group's. */
  let unsigned = [];
  /** The upstream body died mid-answer: the turn is incomplete, not finished. */
  let interrupted = false;
  /** True while a cut answer is awaiting a clean continuation finish. */
  let incomplete = false;
  /** True when the bridge stopped retrying because the client watchdog budget ran low. */
  let timedOut = false;
  /** Answer text seen so far: the tail of it is what a continuation may repeat. */
  let answer = '';
  /** A continuation is being de-duplicated: nothing goes out until the overlap is known. */
  let trimWindow = false;
  let pendingText = '';
  let resumes = 0;
  let lastClientActivityAt = Date.now();
  let lastWireWriteAt = Date.now();
  let lastUpstreamRes = null;
  let firstChunkMs = null;

  const clearHeldTimer = () => {
    if (heldTimer) {
      clearTimeout(heldTimer);
      heldTimer = null;
    }
  };

  const keepaliveTimer = setInterval(() => {
    if (!wrote || res.writableEnded || res.destroyed || controller.signal.aborted) return;
    if (Date.now() - lastWireWriteAt < KEEPALIVE_MS) return;
    try {
      res.write(': keepalive\n\n');
      lastWireWriteAt = Date.now();
    } catch {
      /* socket closed */
    }
  }, KEEPALIVE_MS);
  keepaliveTimer.unref?.();

  const emit = (delta, finishReason = null) => {
    sseHead(res);
    wrote = true;
    lastClientActivityAt = Date.now();
    lastWireWriteAt = lastClientActivityAt;
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
  // A vanished client must not leave timers writing into a dead response.
  res.on('close', () => {
    pacer.stop();
    clearHeldTimer();
    clearInterval(keepaliveTimer);
  });

  const emitContent = (text) => {
    if (!text) return;
    flushHeld();
    startRole();
    counters.content += text.length;
    answer = (answer + text).slice(-RESUME_ANCHOR * 2);
    pacer.push(text);
  };

  /**
   * The longest suffix of what the reader already has that the continuation starts
   * with. Models pick up a sentence or two early, and that repeat must not reach the
   * client twice.
   */
  const overlapLength = (prev, next) => {
    const max = Math.min(prev.length, next.length, RESUME_ANCHOR * 2);
    for (let k = max; k >= 12; k -= 1) {
      if (prev.endsWith(next.slice(0, k))) return k;
    }
    return 0;
  };

  const flushPending = () => {
    if (!pendingText) return;
    const skip = overlapLength(answer, pendingText);
    const rest = pendingText.slice(skip);
    pendingText = '';
    trimWindow = false;
    if (rest) emitContent(rest);
  };

  /** Text goes out as it arrives, except right after a continuation: that one is
   * held until the overlap with the previous leg can be measured. */
  const feedAnswer = (text) => {
    if (!text) return;
    if (!trimWindow) {
      emitContent(text);
      return;
    }
    pendingText += text;
    if (pendingText.length >= RESUME_ANCHOR * 2) flushPending();
  };

  const flushHeld = () => {
    clearHeldTimer();
    if (!held) return;
    const text = held;
    held = '';
    startRole();
    counters.reasoning += text.length;
    emit({ reasoning_content: text });
  };

  const emitReasoning = (text) => {
    if (!text) return;
    if (heldLive) {
      startRole();
      counters.reasoning += text.length;
      emit({ reasoning_content: text });
      return;
    }
    held += text;
    if (held.length >= REASONING_HOLD) {
      heldLive = true;
      flushHeld();
      return;
    }
    if (!heldTimer && REASONING_HOLD_MS > 0) {
      heldTimer = setTimeout(() => {
        heldTimer = null;
        if (controller.signal.aborted || !held) return;
        heldLive = true;
        flushHeld();
      }, REASONING_HOLD_MS);
      heldTimer.unref?.();
    }
  };

  const emitCall = (call) => {
    if (trimWindow && pendingText) flushPending();
    const callId = call.functionCall.id || newCallId();
    const args = sanitizeToolArgs(call.functionCall.args || {});
    // Gemini signs only the first call of a parallel group. Since a client may
    // replay each call on its own, the group's signature is carried by all of
    // them: the same reasoning covers the whole response.
    const signature = call.thoughtSignature || groupSignature;
    rememberCall(callId, signature, call.functionCall.name, args);
    if (!signature) unsigned.push({ id: callId, name: call.functionCall.name, args });
    flushHeld();
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

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const remainingClientBudget = CLIENT_WATCHDOG_MS - (Date.now() - lastClientActivityAt);
      if (attempt > 0 && remainingClientBudget < 45_000) {
        log(`client watchdog budget low (${Math.round(remainingClientBudget / 1000)}s left); surfacing retryable error instead of stalling`);
        timedOut = true;
        break;
      }

      const attemptStartedAt = Date.now();
      const prepared = retryBody(body, attempt);
      const suppressReasoning = Boolean(prepared.__suppressReasoning);
      const splitter = new ThinkingStream();
      clearHeldTimer();
      held = '';
      heldLive = false;
      groupSignature = undefined;
      unsigned = [];
      // finish belongs to the attempt that produced it: a MAX_TOKENS/SAFETY reason
      // from a discarded attempt must not describe the answer that replaced it.
      finish = null;
      let sawFinish = false;

      let upstreamRes;
      try {
        const totalBudgetMs = Math.max(20_000, CLIENT_WATCHDOG_MS - (Date.now() - lastClientActivityAt));
        upstreamRes = await upstream(prepared, controller.signal, { totalBudgetMs });
      } catch (err) {
        // The client pressed Stop before upstream answered: nothing is owed to a
        // connection that is already gone, and a 502 would only be logged against it.
        if (controller.signal.aborted) return;
        if (err && err.name === 'TimeoutError') timedOut = true;
        if (counters.content || counters.toolCalls) break;
        const status = err && err.name === 'TimeoutError' ? 504 : 502;
        return openAiError(res, status, `${status} upstream request failed: ${err.message}`);
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
          const mapped = errorStatus(status);
          return openAiError(res, mapped, `${mapped} ${message.slice(0, 800) || 'upstream error'}`, 'upstream_' + status);
        }
        log(`upstream ${status} on attempt ${attempt + 1} for ${model}; retrying degraded`);
        // Back off a little: a relay that just answered 502 in 40 ms is usually
        // healthy again a second later, and an instant retry lands in the same hole.
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        continue;
      }
      lastUpstreamRes = upstreamRes;

      let failed = false;
      let timed = false;
      const streamBudget = Math.min(
        idleBudget(prepared),
        Math.max(20_000, CLIENT_WATCHDOG_MS - (Date.now() - lastClientActivityAt)),
      );
      try {
        for await (const payload of readSse(upstreamRes.body, streamBudget)) {
          if (!timed) {
            timed = true;
            if (upstreamRes.__agStartedAt) firstChunkMs = Date.now() - upstreamRes.__agStartedAt;
            if (upstreamRes.__agAccount) recordLatency(upstreamRes.__agAccount, firstChunkMs || 0);
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
              if (!part.text.trim()) continue;
              // On retries, suppress short thoughts, but if the model keeps thinking
              // past REASONING_HOLD_MS, stream them so the client watchdog stays alive.
              if (suppressReasoning && Date.now() - attemptStartedAt < REASONING_HOLD_MS) continue;
              emitReasoning(part.text);
              continue;
            }
            for (const piece of splitter.push(part.text)) {
              if (piece.kind === 'reasoning') {
                if (!suppressReasoning || Date.now() - attemptStartedAt >= REASONING_HOLD_MS) emitReasoning(piece.text);
              } else {
                feedAnswer(piece.text);
              }
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        log('stream interrupted: ' + err.message);
        const isTimeout = Boolean(err) && err.name === 'TimeoutError';
        if (isTimeout) timedOut = true;
        const stalledThought = isTimeout && !counters.content && !counters.toolCalls;
        if (stalledThought) {
          log(`thinking stalled on ${model} (attempt ${attempt + 1}); retrying with thinking reduced`);
        }
        failed = !stalledThought;
        interrupted = !stalledThought;
      }

      clearHeldTimer();
      for (const piece of splitter.flush()) {
        if (piece.kind === 'reasoning') {
          // Reasoning released after the answer started would reorder the turn.
          if ((!suppressReasoning || Date.now() - attemptStartedAt >= REASONING_HOLD_MS) && !counters.content) {
            emitReasoning(piece.text);
          }
        } else {
          feedAnswer(piece.text);
        }
      }
      if (trimWindow && pendingText) flushPending();

      // A stream that ends without a finish reason was cut, not completed: the last
      // chunk is where upstream says how the turn ended. A lost tail read as a normal
      // stop is how half an answer becomes the answer the client stores.
      if (!failed && !sawFinish) {
        log('upstream stream ended without a finish reason; treating it as interrupted');
        failed = true;
        interrupted = true;
      }

      // A turn that produced no answer keeps nothing: its held thoughts would
      // render as a step that thinks and then does nothing at all.
      if (!counters.content && !counters.toolCalls) {
        held = '';
        heldLive = false;
      }

      if (failed) {
        const answeredNow = counters.content > 0 || counters.toolCalls > 0;
        const room = attempt < MAX_ATTEMPTS - 1;
        // A cut before the answer even started costs nothing to retry.
        if (interrupted && !answeredNow && room) {
          interrupted = false;
          failed = false;
          log(`upstream cut before any answer (attempt ${attempt + 1}); retrying`);
          continue;
        }
        // A cut in the middle of an answer is continued, not thrown away. Tool calls
        // are the exception: half an argument list cannot be stitched together.
        if (interrupted && answeredNow && !counters.toolCalls && resumes < RESUME_ATTEMPTS && room) {
          const tail = answer.slice(-RESUME_ANCHOR);
          if (tail.trim().length >= 40) {
            resumes += 1;
            log(`stream cut after ${counters.content} chars; continuing the answer (${resumes}/${RESUME_ATTEMPTS})`);
            body = continuationBody(body, tail);
            trimWindow = true;
            pendingText = '';
            incomplete = true;
            interrupted = false;
            failed = false;
            continue;
          }
        }
        break;
      }

      incomplete = false;
      if ((finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') && !counters.content && !counters.toolCalls && attempt < MAX_ATTEMPTS - 1) {
        log(`upstream ${finish} for ${model} (attempt ${attempt + 1}); retrying with thinking reduced`);
        continue;
      }
      if (counters.content || counters.toolCalls) break;
      if (attempt === MAX_ATTEMPTS - 1) break;
      log(`empty answer for ${model} (attempt ${attempt + 1}, finish=${finish || 'none'}, thinkChars=${counters.reasoning}); retrying with thinking reduced`);
    }

    // Nothing may still be queued when the closing chunk goes out, or the tail of
    // the answer would arrive after finish_reason and be dropped by the client.
    if (counters.content || counters.toolCalls) flushHeld();
    pacer.flush();
    flushSignatures();

    // Reasoning is not an answer. A client that receives thoughts and then
    // finish_reason "stop" renders a step that said nothing, treats the turn as
    // complete and stops the agent loop there — the task looks finished while nothing
    // was produced. When nothing visible came out, an error is the honest result,
    // even if reasoning already reached the wire.
    const answered = counters.content > 0 || counters.toolCalls > 0;
    if (!wrote || !answered) {
      if (interrupted || incomplete) {
        return openAiError(
          res,
          502,
          '502 upstream stream ended without completion before any answer',
          'stream_interrupted',
        );
      }
      if (timedOut) {
        return openAiError(
          res,
          504,
          '504 upstream stream timed out before answering',
          'upstream_timeout',
        );
      }
      return openAiError(res, 502, '502 upstream returned an empty answer', 'empty_upstream_response');
    }

    if (interrupted || incomplete) {
      // Half an answer is not an answer: say so, instead of ending the turn with
      // finish_reason "stop" and letting the client store a cut sentence as final.
      // openAiError turns this into an SSE error event once the headers are out.
      log(`stream interrupted after ${counters.content} answer chars; reporting it to the client`);
      return openAiError(
        res,
        502,
        '502 upstream stream ended without completion; the answer above is incomplete',
        'stream_interrupted',
      );
    }

    // Only STOP is a normal end. Dressing a safety block or a broken tool call up as
    // "stop" hands the client a turn that looks finished while nothing came out.
    if (finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') {
      log(`upstream could not build a valid tool call (${finish}); reporting it to the client`);
      return openAiError(
        res,
        502,
        `502 upstream could not build a valid tool call (${finish})`,
        'upstream_function_call_failed',
      );
    }

    const FILTERED = {
      SAFETY: 1,
      RECITATION: 1,
      BLOCKLIST: 1,
      PROHIBITED_CONTENT: 1,
      SPII: 1,
      IMAGE_SAFETY: 1,
      OTHER: 1,
    };
    const finishReason = FILTERED[finish]
      ? 'content_filter'
      : counters.toolCalls > 0
        ? 'tool_calls'
        : finish === 'MAX_TOKENS'
          ? 'length'
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
          ` think=${usage.thoughtsTokenCount || 0} cached=${usage.cachedContentTokenCount || 0}` +
          (firstChunkMs !== null ? ` ttft=${firstChunkMs}ms` : ''),
      );
    }
    if (lastUpstreamRes) {
      scheduleKeepAlive({
        account: lastUpstreamRes.__agAccount,
        payload: lastUpstreamRes.__agPayload,
        usage,
      });
    }
    sseHead(res);
    res.write('data: ' + JSON.stringify(finalChunk) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    clearHeldTimer();
    clearInterval(keepaliveTimer);
  }
}
