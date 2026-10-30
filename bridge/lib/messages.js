/**
 * OpenAI chat messages -> Gemini `contents`.
 *
 * Two rules matter more than the mapping itself: a thinking block that the client
 * replays must never be sent back as if it were the answer (Gemini mimics whatever
 * it sees in history), and a tool result must be matched to its call by id so the
 * model gets `functionResponse` with the right name instead of a bare string.
 */

import { nameForCall, signatureFor } from './signatures.js';

export function imagePart(url) {
  if (typeof url !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

export function toContents(messages) {
  const system = [];
  const contents = [];
  const pendingResponses = new Map();

  const flushResponses = () => {
    if (!pendingResponses.size) return;
    contents.push({ role: 'user', parts: [...pendingResponses.values()] });
    pendingResponses.clear();
  };

  for (const message of messages || []) {
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === 'user') {
      flushResponses();
      const parts = [];
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part) continue;
          if (part.type === 'text' && part.text) parts.push({ text: part.text });
          else if (part.type === 'image_url') {
            const image = imagePart(part.image_url && part.image_url.url);
            if (image) parts.push(image);
          }
        }
      } else {
        const text = textOf(message.content);
        if (text) parts.push({ text });
      }
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }
    if (role === 'assistant') {
      flushResponses();
      const parts = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls || []) {
        if (!call || !call.function) continue;
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = { raw: String(call.function.arguments) };
        }
        const part = { functionCall: { name: call.function.name, args } };
        const signature = signatureFor(call.id);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (role === 'tool') {
      const callId = message.tool_call_id;
      const name = nameForCall(callId) || message.name || 'tool';
      const body = textOf(message.content);
      let result;
      try {
        result = JSON.parse(body);
      } catch {
        result = body;
      }
      pendingResponses.set(callId || name + Math.random(), {
        functionResponse: { name, response: { result } },
      });
      continue;
    }
  }
  flushResponses();
  return { system, contents };
}
