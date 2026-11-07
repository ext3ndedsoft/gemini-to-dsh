/**
 * Paced delivery of generated text.
 *
 * Upstream hands us roughly 25 tokens every ~300 ms, and a client that paints each
 * delta the moment it lands shows the answer in lumps. This spreads every arrival
 * over a few small deltas so the text appears at a steady rate, while never falling
 * behind the real stream: the queue is sized to drain in about eight ticks.
 *
 * Set AG_PACE=0 to pass text through untouched, AG_PACE_MS to change the cadence.
 */

const DISABLED = process.env.AG_PACE === '0';
const rawTick = Number(process.env.AG_PACE_MS || 30);
// A non-numeric AG_PACE_MS ("30 мс", "30ms") gives NaN, and Math.max(10, NaN) is
// still NaN: setTimeout(fn, NaN) fires after ~1 ms, so pacing quietly turned into a
// stream of one-millisecond chunks with a busy timer.
const DEFAULT_TICK = Number.isFinite(rawTick) && rawTick > 0 ? rawTick : 30;
/** How many ticks a full queue should take to drain — smaller means smoother. */
const DRAIN_TICKS = 8;

export class Pacer {
  constructor(emit, { tickMs = DEFAULT_TICK } = {}) {
    this.emit = emit;
    this.tickMs = Number.isFinite(tickMs) ? Math.max(10, tickMs) : DEFAULT_TICK;
    this.queue = '';
    this.timer = null;
    this.closed = false;
  }

  push(text) {
    if (!text || this.closed) return;
    if (DISABLED) {
      this.emit(text);
      return;
    }
    this.queue += text;
    this.arm();
  }

  arm() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => this.tick(), this.tickMs);
    // Never let pacing keep the process alive on its own.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  tick() {
    this.timer = null;
    if (this.closed || !this.queue) return;
    const take = Math.max(1, Math.ceil(this.queue.length / DRAIN_TICKS));
    let end = Math.min(take, this.queue.length);
    // Cut on a code point boundary so a surrogate pair never splits across deltas.
    if (end < this.queue.length) {
      const code = this.queue.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end += 1;
    }
    const slice = this.queue.slice(0, end);
    this.queue = this.queue.slice(end);
    this.emit(slice);
    if (this.queue) this.arm();
  }

  /** Release everything still queued; used before the closing chunk. */
  flush() {
    this.stop();
    const rest = this.queue;
    this.queue = '';
    if (rest) this.emit(rest);
  }

  /** Drop whatever is queued — the turn is over or the client is gone. */
  stop() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}