/**
 * Thinking arrives on two different channels: Gemini's native `thought` parts,
 * and text where the model writes `<thinking>` tags straight into the answer
 * because its prompt asked it to. The second form is what makes a bridge answer
 * look like it never thought at all: the tags land in `content` and the client
 * renders them as visible prose. This module moves a leading tag block onto the
 * reasoning channel, whichever channel it was written to.
 *
 * Streaming-safe: the opening tag is held back until it is known to be a tag,
 * and the closing tag is never emitted as either channel.
 */

const OPEN_PREFIXES = ['<thinking'];
const OPEN_TAG = /^\s*<thinking(\s[^>]*)?>/i;
const CLOSE_TAG = /<\/thinking\s*>/i;
const CLOSE_LOOKAHEAD = '</thinking>'.length - 1;
const LEADING_SPACE_CAP = 64;
const THINK_CAP = 200_000;

/** True while `text` could still grow into an opening tag. */
function couldBecomeTag(text) {
  return OPEN_PREFIXES.some((prefix) => prefix.startsWith(text) || (text.startsWith(prefix) && !text.includes('>')));
}

export class ThinkingStream {
  constructor() {
    this.state = 'start';
    this.pending = '';
    this.emitted = 0;
  }

  /** Feed a content delta; returns the pieces to emit, in order. */
  push(text) {
    if (!text) return [];
    this.pending += text;
    return this.drain();
  }

  /** No more content is coming: release whatever is held back. */
  flush() {
    const out = this.drain(true);
    if (!this.pending) return out;

    const rest = this.pending;
    this.pending = '';
    if (this.state === 'thinking') {
      this.emitted += rest.length;
      out.push({ kind: 'reasoning', text: rest });
    } else {
      out.push({ kind: 'content', text: rest });
    }
    this.state = 'text';
    return out;
  }

  drain(final = false) {
    const out = [];
    for (;;) {
      if (this.state === 'start') {
        const pending = this.pending;
        if (!pending) return out;
        const trimmed = pending.trimStart();
        if (!trimmed) {
          // Whitespace only so far: it belongs in front of the tag, not the answer.
          if (final || pending.length > LEADING_SPACE_CAP) {
            this.pending = '';
            this.state = 'text';
            out.push({ kind: 'content', text: pending });
          }
          return out;
        }
        const match = OPEN_TAG.exec(pending);
        if (match) {
          this.pending = pending.slice(match[0].length);
          this.state = 'thinking';
          continue;
        }
        if (couldBecomeTag(trimmed) && !final) return out;
        out.push({ kind: 'content', text: pending });
        this.pending = '';
        this.state = 'text';
        continue;
      }

      if (this.state === 'thinking') {
        const close = CLOSE_TAG.exec(this.pending);
        if (close) {
          const before = this.pending.slice(0, close.index);
          this.pending = this.pending.slice(close.index + close[0].length);
          this.emitted += before.length;
          if (before) out.push({ kind: 'reasoning', text: before });
          this.state = 'text';
          continue;
        }
        // Stream the safe part, keep the tail that could be half a closing tag.
        if (this.pending.length > CLOSE_LOOKAHEAD) {
          const safe = this.pending.slice(0, this.pending.length - CLOSE_LOOKAHEAD);
          this.pending = this.pending.slice(-CLOSE_LOOKAHEAD);
          this.emitted += safe.length;
          if (safe) out.push({ kind: 'reasoning', text: safe });
        }
        // A model that never closes the tag is just answering: stop hiding it.
        if (this.emitted > THINK_CAP) {
          const rest = this.pending;
          this.pending = '';
          this.state = 'text';
          if (rest) out.push({ kind: 'content', text: rest });
        }
        return out;
      }

      if (!this.pending) return out;
      out.push({ kind: 'content', text: this.pending });
      this.pending = '';
      return out;
    }
    return out;
  }
}

/** Non-streaming variant: one string in, reasoning and content out. */
export function splitThinking(text) {
  if (!text) return { reasoning: '', content: '' };
  const stream = new ThinkingStream();
  const pieces = [...stream.push(text), ...stream.flush()];
  let reasoning = '';
  let content = '';
  for (const piece of pieces) {
    if (piece.kind === 'reasoning') reasoning += piece.text;
    else content += piece.text;
  }
  return { reasoning: reasoning.trim() ? reasoning : '', content };
}
