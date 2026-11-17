// The wire contract of ../PROTOCOL.md, browser side. Pure: no serial port,
// no timers, no DOM. Every function that depends on time takes `now` in ms.

import { LINK } from './config.js';

/** Game phase -> the `phase` field of the hud line. */
export const PHASE_CODE = Object.freeze({ ready: 0, playing: 1, paused: 2, over: 3 });

const INT = /^-?\d{1,9}$/;
const UINT = /^\d{1,9}$/;
const MIC_MIN = -12000;
// The contract says the level rises "towards 0". A little above 0 is tolerated
// and clamped; anything far above is a corrupted line (e.g. a lost minus sign).
const MIC_MAX_TOLERATED = 600;

/**
 * Parses one received line.
 * Returns { type: 'state', k, t, z, h, m }, { type: 'hello', name, version }
 * or null for everything that is not a well-formed protocol line (ESP-IDF log
 * output, test console replies, truncated or merged lines).
 */
export function parseLine(raw) {
  if (typeof raw !== 'string') return null;
  const line = raw.replace(/[\r\n]+$/, '');
  if (!line.startsWith('!')) return null;
  const parts = line.trimEnd().split(/ +/);

  if (parts[0] === '!s') {
    if (parts.length !== 6) return null;
    if (!INT.test(parts[1]) || !INT.test(parts[5])) return null;
    if (!UINT.test(parts[2]) || !UINT.test(parts[3]) || !UINT.test(parts[4])) return null;
    const m = Number(parts[5]);
    if (m > MIC_MAX_TOLERATED) return null;
    return {
      type: 'state',
      k: Number(parts[1]),
      t: Number(parts[2]),
      z: Number(parts[3]),
      h: Number(parts[4]),
      m: Math.min(0, Math.max(MIC_MIN, m)),
    };
  }

  if (parts[0] === '!hello') {
    if (parts.length !== 3 || !UINT.test(parts[2])) return null;
    return { type: 'hello', name: parts[1], version: Number(parts[2]) };
  }

  return null;
}

/**
 * Turns the absolute counters of successive `!s` lines into input events.
 *
 * The first line after a (re)connect only sets the baseline. A tap/circle/hold
 * counter that went down means the device rebooted: the baseline moves and no
 * events fire. A jump too large to be real input (see LINK.MAX_*) is handled
 * the same way, so a line that lost a digit on the way cannot fire a burst.
 */
export class InputDecoder {
  #base = null;
  resyncs = 0;

  /** Forget the baseline (call when the port opens or closes). */
  reset() {
    this.#base = null;
  }

  /** @returns {{ events: object[], resync: boolean }} */
  push(msg) {
    if (!msg || msg.type !== 'state') return { events: [], resync: false };
    const base = this.#base;
    this.#base = { k: msg.k, t: msg.t, z: msg.z, h: msg.h };
    if (!base) {
      this.resyncs += 1;
      return { events: [], resync: true };
    }

    const dk = msg.k - base.k;
    const dt = msg.t - base.t;
    const dz = msg.z - base.z;
    const dh = msg.h - base.h;
    const rebooted = dt < 0 || dz < 0 || dh < 0;
    const implausible =
      Math.abs(dk) > LINK.MAX_DETENTS_PER_LINE ||
      dt > LINK.MAX_COUNT_STEP ||
      dz > LINK.MAX_COUNT_STEP ||
      dh > LINK.MAX_COUNT_STEP;
    if (rebooted || implausible) {
      this.resyncs += 1;
      return { events: [], resync: true };
    }

    const events = [];
    if (dk !== 0) events.push({ type: 'turn', detents: dk });
    for (let i = 0; i < dz; i++) events.push({ type: 'flip' });
    for (let i = 0; i < dt; i++) events.push({ type: 'tap' });
    for (let i = 0; i < dh; i++) events.push({ type: 'hold' });
    return { events, resync: false };
  }
}

/** `hello` */
export function formatHello() {
  return 'hello';
}

const toInt = (value, lo, hi) => {
  const n = Number.isFinite(value) ? Math.round(value) : lo;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * `hud <score> <health> <breath> <phase> <pol>`.
 * `phase` is a game phase name ('ready', 'playing', 'paused', 'over').
 * A core that is still alive never shows as 0 health.
 */
export function formatHud({ score, health, breath, phase, polarity }) {
  const hp = health > 0 ? Math.max(1, toInt(health, 0, 100)) : 0;
  const code = PHASE_CODE[phase] ?? 0;
  return `hud ${toInt(score, 0, 999999)} ${hp} ${toInt(breath, 0, 100)} ${code} ${polarity ? 1 : 0}`;
}

/** `hap <effect>`, or null when the effect is not a DRV2605L waveform 1..123. */
export function formatHap(effect) {
  if (!Number.isInteger(effect) || effect < 1 || effect > 123) return null;
  return `hap ${effect}`;
}

/**
 * Decides when a hud line goes out: on change, at most once per
 * LINK.HUD_MIN_INTERVAL_MS, and at least once per LINK.HUD_HEARTBEAT_MS.
 */
export class HudScheduler {
  #lastLine = null;
  #lastAt = null;

  constructor({ minIntervalMs = LINK.HUD_MIN_INTERVAL_MS, heartbeatMs = LINK.HUD_HEARTBEAT_MS } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.heartbeatMs = heartbeatMs;
  }

  /** Makes the next poll send (call when the port opens). */
  reset() {
    this.#lastLine = null;
    this.#lastAt = null;
  }

  /** @returns {string|null} the line to send now, or null */
  poll(line, now) {
    const since = this.#lastAt === null ? Infinity : now - this.#lastAt;
    const changed = line !== this.#lastLine;
    if ((changed && since >= this.minIntervalMs) || since >= this.heartbeatMs) {
      this.#lastLine = line;
      this.#lastAt = now;
      return line;
    }
    return null;
  }
}

/**
 * Spaces haptic effects at least LINK.HAP_MIN_GAP_MS apart. While the gap is
 * closed one effect waits; a more important one replaces it, and one that
 * waited too long is dropped (a late buzz is worse than none).
 */
export class HapticLimiter {
  #lastAt = -Infinity;
  #pending = null;
  sent = 0;
  dropped = 0;

  constructor({ minGapMs = LINK.HAP_MIN_GAP_MS, maxAgeMs = LINK.HAP_MAX_AGE_MS } = {}) {
    this.minGapMs = minGapMs;
    this.maxAgeMs = maxAgeMs;
  }

  reset() {
    this.#lastAt = -Infinity;
    this.#pending = null;
  }

  /** Queues an effect; of two waiting effects the higher priority survives. */
  offer(effect, priority, now) {
    if (!Number.isInteger(effect) || effect < 1 || effect > 123) return;
    if (this.#pending) {
      this.dropped += 1;
      if (priority <= this.#pending.priority) return;
    }
    this.#pending = { effect, priority, at: now };
  }

  /** @returns {number|null} the effect to send now, or null */
  poll(now) {
    const p = this.#pending;
    if (!p) return null;
    if (now - p.at > this.maxAgeMs) {
      this.#pending = null;
      this.dropped += 1;
      return null;
    }
    if (now - this.#lastAt < this.minGapMs) return null;
    this.#pending = null;
    this.#lastAt = now;
    this.sent += 1;
    return p.effect;
  }
}

/**
 * Splits a byte stream (already decoded to text) into lines. Tolerates
 * `\r\n`, lines split across chunks, and drops lines longer than the limit.
 */
export class LineSplitter {
  #buf = '';
  #skipping = false;

  constructor(maxLength = LINK.MAX_LINE_LENGTH) {
    this.maxLength = maxLength;
  }

  reset() {
    this.#buf = '';
    this.#skipping = false;
  }

  /** @returns {string[]} the complete lines contained in the data so far */
  push(chunk) {
    const out = [];
    this.#buf += chunk;
    for (;;) {
      const end = this.#buf.indexOf('\n');
      if (end < 0) break;
      let line = this.#buf.slice(0, end);
      this.#buf = this.#buf.slice(end + 1);
      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length <= this.maxLength) out.push(line);
    }
    if (this.#buf.length > this.maxLength) {
      this.#buf = '';
      this.#skipping = true;
    }
    return out;
  }
}
