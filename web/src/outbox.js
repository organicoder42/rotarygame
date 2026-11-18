// What goes out over Bluetooth, and in which order. Pure: no Web Bluetooth,
// no timers. ble.js asks for one piece at a time and reports how it went.
//
// Web Bluetooth allows one GATT operation at a time per device, so everything
// queues behind the write in flight. The policy for what may wait:
//
//   hud    at most one waits; a newer one replaces it (only the latest state
//          is worth showing).
//   hap    at most one waits; a newer one replaces it, and one that has waited
//          longer than hapMaxWaitMs is skipped instead of played late.
//   other  (`hello`) first in, first out, a few at most; a line that is
//          already waiting is not queued twice.
//
// Order: other lines first, then hap, then hud. A hap does not jump the same
// waiting hud twice in a row, so the heartbeat cannot starve.
// The pieces of one line always go out together and in order. If a piece
// fails after an earlier piece of the same line was delivered, the rest of
// the line is dropped and a lone "\n" goes out first next time, so that the
// fragment on the device cannot merge with the following line.

import { BLE } from './config.js';

const NEWLINE = 10;
const encoder = new TextEncoder();

/** The bytes of one line on the wire: the text and a closing "\n". */
export function encodeLine(line) {
  return encoder.encode(`${line}\n`);
}

/** Splits bytes into pieces of at most `size` bytes, in order. */
export function chunkBytes(bytes, size = BLE.CHUNK_BYTES) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const chunks = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
  return chunks;
}

const kindOf = (line) => (line.startsWith('hud ') ? 'hud' : line.startsWith('hap ') ? 'hap' : 'other');

export class WriteQueue {
  /** The line being written: { chunks, index, terminator }. */
  #current = null;
  /** True between next() and ack()/fail(). */
  #inFlight = false;
  #other = [];
  #hap = null;
  #hud = null;
  #lastWasHap = false;
  /** A line was cut short on the device: close it before anything else. */
  #terminate = false;

  stats = { lines: 0, chunks: 0, replacedHud: 0, replacedHap: 0, expiredHap: 0, rejected: 0, failed: 0 };

  constructor({
    chunkSize = BLE.CHUNK_BYTES,
    hapMaxWaitMs = BLE.HAP_MAX_WAIT_MS,
    maxPending = BLE.MAX_PENDING_LINES,
  } = {}) {
    this.chunkSize = chunkSize;
    this.hapMaxWaitMs = hapMaxWaitMs;
    this.maxPending = maxPending;
  }

  /** Lines waiting for their turn (not counting the one being written). */
  get waiting() {
    return this.#other.length + (this.#hap ? 1 : 0) + (this.#hud ? 1 : 0);
  }

  /** True when nothing is waiting and nothing is being written. */
  get idle() {
    return !this.#current && !this.#terminate && this.waiting === 0;
  }

  /**
   * Queues one line (without its "\n"). Returns false when it was refused.
   * A line already being written is never touched.
   */
  offer(line, now) {
    if (typeof line !== 'string' || line === '' || /[\r\n]/.test(line)) return false;
    switch (kindOf(line)) {
      case 'hud':
        if (this.#hud) this.stats.replacedHud += 1;
        this.#hud = { line };
        return true;
      case 'hap':
        if (this.#hap) this.stats.replacedHap += 1;
        this.#hap = { line, at: now };
        return true;
      default:
        if (this.#other.includes(line)) return true;
        if (this.#other.length >= this.maxPending) {
          this.stats.rejected += 1;
          return false;
        }
        this.#other.push(line);
        return true;
    }
  }

  /**
   * The next piece to write, or null when there is nothing to do or a piece
   * is still in flight. Every piece handed out must be answered with ack() or
   * fail() before the next one is given.
   */
  next(now) {
    if (this.#inFlight) return null;
    if (!this.#current) {
      if (this.#terminate) {
        this.#terminate = false;
        this.#current = { chunks: [Uint8Array.of(NEWLINE)], index: 0, terminator: true };
      } else {
        const line = this.#take(now);
        if (line === null) return null;
        this.#current = { chunks: chunkBytes(encodeLine(line), this.chunkSize), index: 0, terminator: false };
      }
    }
    this.#inFlight = true;
    return this.#current.chunks[this.#current.index];
  }

  /** The piece handed out by next() was written. */
  ack() {
    if (!this.#inFlight) return;
    this.#inFlight = false;
    this.stats.chunks += 1;
    const current = this.#current;
    current.index += 1;
    if (current.index >= current.chunks.length) {
      this.#current = null;
      if (!current.terminator) this.stats.lines += 1;
    }
  }

  /** The piece handed out by next() was not written: give up on its line. */
  fail() {
    if (!this.#inFlight) return;
    this.#inFlight = false;
    this.stats.failed += 1;
    const current = this.#current;
    this.#current = null;
    if (current.index > 0 || current.terminator) this.#terminate = true;
  }

  /** Forget everything (the link went away or a new one starts). */
  clear() {
    this.#current = null;
    this.#inFlight = false;
    this.#other = [];
    this.#hap = null;
    this.#hud = null;
    this.#lastWasHap = false;
    this.#terminate = false;
  }

  #take(now) {
    if (this.#other.length) {
      this.#lastWasHap = false;
      return this.#other.shift();
    }
    if (this.#hap && now - this.#hap.at > this.hapMaxWaitMs) {
      this.#hap = null;
      this.stats.expiredHap += 1;
    }
    if (this.#hap && !(this.#lastWasHap && this.#hud)) {
      const { line } = this.#hap;
      this.#hap = null;
      this.#lastWasHap = true;
      return line;
    }
    if (this.#hud) {
      const { line } = this.#hud;
      this.#hud = null;
      this.#lastWasHap = false;
      return line;
    }
    return null;
  }
}
