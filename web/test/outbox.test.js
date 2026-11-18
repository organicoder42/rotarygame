import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BLE } from '../src/config.js';
import { WriteQueue, chunkBytes, encodeLine } from '../src/outbox.js';

const text = (bytes) => new TextDecoder().decode(bytes);

/** Writes everything the queue hands out and returns it as text pieces. */
function drain(queue, now = 0) {
  const out = [];
  for (;;) {
    const chunk = queue.next(now);
    if (!chunk) return out;
    out.push(text(chunk));
    queue.ack();
  }
}

describe('encodeLine and chunkBytes', () => {
  it('a line on the wire is its text and one "\\n"', () => {
    assert.deepEqual([...encodeLine('hap 14')], [104, 97, 112, 32, 49, 52, 10]);
  });

  it('the contract allows at most 20 bytes per write', () => {
    assert.equal(BLE.CHUNK_BYTES, 20);
  });

  it('a short line is one piece', () => {
    const chunks = chunkBytes(encodeLine('hello'));
    assert.deepEqual(chunks.map(text), ['hello\n']);
  });

  it('exactly 20 bytes is still one piece, 21 is two', () => {
    assert.deepEqual(chunkBytes(new Uint8Array(20)).map((c) => c.length), [20]);
    assert.deepEqual(chunkBytes(new Uint8Array(21)).map((c) => c.length), [20, 1]);
  });

  it('splits the longest hud line in order and loses nothing', () => {
    const line = 'hud 999999 100 100 3 1';
    const chunks = chunkBytes(encodeLine(line));
    assert.deepEqual(chunks.map(text), ['hud 999999 100 100 3', ' 1\n']);
    for (const chunk of chunks) assert.ok(chunk.length <= 20);
    assert.equal(chunks.map(text).join(''), `${line}\n`);
  });

  it('splits long input into many pieces of the requested size', () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => i);
    const chunks = chunkBytes(bytes, 7);
    assert.deepEqual(chunks.map((c) => c.length), [7, 7, 7, 7, 7, 7, 7, 1]);
    assert.deepEqual(chunks.flatMap((c) => [...c]), [...bytes]);
  });

  it('pieces are copies, not views into the same buffer', () => {
    const bytes = encodeLine('hud 999999 100 100 3 1');
    const [first] = chunkBytes(bytes);
    assert.equal(first.byteOffset, 0);
    assert.equal(first.buffer.byteLength, first.length);
  });

  it('empty input gives no pieces, a silly size is refused', () => {
    assert.deepEqual(chunkBytes(new Uint8Array(0)), []);
    assert.throws(() => chunkBytes(new Uint8Array(3), 0), RangeError);
    assert.throws(() => chunkBytes(new Uint8Array(3), 2.5), RangeError);
  });
});

describe('WriteQueue: one write at a time', () => {
  it('hands out nothing when nothing was offered', () => {
    const q = new WriteQueue();
    assert.equal(q.next(0), null);
    assert.equal(q.idle, true);
  });

  it('gives no second piece before the first was answered', () => {
    const q = new WriteQueue();
    q.offer('hud 999999 100 100 3 1', 0);
    q.offer('hello', 0);
    assert.equal(text(q.next(0)), 'hello\n');
    assert.equal(q.next(0), null, 'still in flight');
    assert.equal(q.next(0), null);
    q.ack();
    assert.equal(text(q.next(0)), 'hud 999999 100 100 3');
    assert.equal(q.next(0), null);
  });

  it('ack() and fail() without a piece in flight do nothing', () => {
    const q = new WriteQueue();
    q.ack();
    q.fail();
    q.offer('hello', 0);
    assert.deepEqual(drain(q), ['hello\n']);
    assert.equal(q.stats.failed, 0);
  });

  it('refuses things that are not one line', () => {
    const q = new WriteQueue();
    for (const bad of ['', 'hud 1\nhap 2', 'hello\r', undefined, null, 42]) assert.equal(q.offer(bad, 0), false);
    assert.equal(q.idle, true);
  });
});

describe('WriteQueue: what may wait behind a slow link', () => {
  it('keeps only the newest waiting hud', () => {
    const q = new WriteQueue();
    q.offer('hud 1 100 100 1 1', 0);
    q.offer('hud 2 100 100 1 1', 10);
    q.offer('hud 3 100 100 1 1', 20);
    assert.equal(q.waiting, 1);
    assert.deepEqual(drain(q), ['hud 3 100 100 1 1\n']);
    assert.equal(q.stats.replacedHud, 2);
  });

  it('a hud that is already being written is finished, never swapped half-way', () => {
    const q = new WriteQueue();
    q.offer('hud 999999 100 100 3 1', 0);
    assert.equal(text(q.next(0)), 'hud 999999 100 100 3');
    q.offer('hud 5 50 50 1 0', 1);
    q.offer('hud 6 50 50 1 0', 2);
    q.ack();
    assert.equal(text(q.next(0)), ' 1\n', 'the rest of the first line comes next');
    q.ack();
    assert.deepEqual(drain(q), ['hud 6 50 50 1 0\n']);
  });

  it('never reorders or interleaves the pieces of one line', () => {
    const q = new WriteQueue({ chunkSize: 5 });
    q.offer('hud 123456 100 100 1 1', 0);
    const first = text(q.next(0));
    q.offer('hap 14', 0);
    q.offer('hello', 0);
    q.ack();
    const pieces = [first, ...drain(q)];
    assert.equal(pieces.join(''), 'hud 123456 100 100 1 1\nhello\nhap 14\n');
  });

  it('sends a waiting hap before a waiting hud', () => {
    const q = new WriteQueue();
    q.offer('hud 1 100 100 1 1', 0);
    q.offer('hap 14', 0);
    assert.deepEqual(drain(q), ['hap 14\n', 'hud 1 100 100 1 1\n']);
  });

  it('other lines (hello) go first and in the order they came', () => {
    const q = new WriteQueue();
    q.offer('hud 1 100 100 1 1', 0);
    q.offer('hap 14', 0);
    q.offer('hello', 0);
    q.offer('ping', 0);
    assert.deepEqual(drain(q), ['hello\n', 'ping\n', 'hap 14\n', 'hud 1 100 100 1 1\n']);
  });

  it('skips a hap that waited too long, and still sends the hud', () => {
    const q = new WriteQueue();
    q.offer('hello', 0);
    assert.ok(q.next(0)); // hello in flight on a slow link
    q.offer('hap 14', 10);
    q.offer('hud 1 100 100 1 1', 10);
    q.ack();
    assert.deepEqual(drain(q, 10 + BLE.HAP_MAX_WAIT_MS + 1), ['hud 1 100 100 1 1\n']);
    assert.equal(q.stats.expiredHap, 1);
    assert.equal(q.idle, true);
  });

  it('plays a hap that waited exactly as long as allowed', () => {
    const q = new WriteQueue();
    q.offer('hap 14', 10);
    assert.deepEqual(drain(q, 10 + BLE.HAP_MAX_WAIT_MS), ['hap 14\n']);
    assert.equal(q.stats.expiredHap, 0);
  });

  it('of two waiting haps only the newer one is played', () => {
    const q = new WriteQueue();
    q.offer('hello', 0);
    assert.ok(q.next(0));
    q.offer('hap 24', 5);
    q.offer('hap 14', 80);
    q.ack();
    // The newer one is judged by its own age, not by the age of the first.
    assert.deepEqual(drain(q, 5 + BLE.HAP_MAX_WAIT_MS + 20), ['hap 14\n']);
    assert.equal(q.stats.replacedHap, 1);
  });

  it('a hap does not jump the same waiting hud twice in a row', () => {
    const q = new WriteQueue();
    q.offer('hud 1 100 100 1 1', 0);
    q.offer('hap 1', 0);
    assert.equal(text(q.next(0)), 'hap 1\n');
    q.offer('hap 2', 1); // arrives while the first hap is being written
    q.ack();
    assert.equal(text(q.next(1)), 'hud 1 100 100 1 1\n', 'the heartbeat gets its turn');
    q.ack();
    assert.equal(text(q.next(1)), 'hap 2\n');
  });

  it('haps in a row are fine when no hud is waiting', () => {
    const q = new WriteQueue();
    q.offer('hap 1', 0);
    assert.deepEqual(drain(q), ['hap 1\n']);
    q.offer('hap 2', 0);
    assert.deepEqual(drain(q), ['hap 2\n']);
  });

  it('does not queue the same waiting line twice (hello retries on a stuck link)', () => {
    const q = new WriteQueue();
    for (let i = 0; i < 10; i++) assert.equal(q.offer('hello', i), true);
    assert.equal(q.waiting, 1);
    assert.deepEqual(drain(q), ['hello\n']);
  });

  it('refuses other lines beyond the limit instead of growing', () => {
    const q = new WriteQueue({ maxPending: 2 });
    assert.equal(q.offer('a', 0), true);
    assert.equal(q.offer('b', 0), true);
    assert.equal(q.offer('c', 0), false);
    assert.equal(q.stats.rejected, 1);
    assert.deepEqual(drain(q), ['a\n', 'b\n']);
  });

  it('never holds more than the limit plus one hud and one hap', () => {
    const q = new WriteQueue();
    for (let i = 0; i < 500; i++) {
      q.offer(`hud ${i} 100 100 1 1`, i);
      q.offer(`hap ${(i % 123) + 1}`, i);
      q.offer(`x${i}`, i);
    }
    assert.equal(q.waiting, BLE.MAX_PENDING_LINES + 2);
  });

  it('counts lines and pieces', () => {
    const q = new WriteQueue();
    q.offer('hud 999999 100 100 3 1', 0);
    q.offer('hap 14', 0);
    drain(q);
    assert.equal(q.stats.lines, 2);
    assert.equal(q.stats.chunks, 3);
  });
});

describe('WriteQueue: a write that failed', () => {
  it('drops the line whose first piece failed and carries on with the next', () => {
    const q = new WriteQueue();
    q.offer('hello', 0);
    q.offer('hud 1 100 100 1 1', 0);
    assert.equal(text(q.next(0)), 'hello\n');
    q.fail();
    assert.deepEqual(drain(q), ['hud 1 100 100 1 1\n']);
    assert.equal(q.stats.failed, 1);
  });

  it('closes a line that was cut short on the device before sending anything else', () => {
    const q = new WriteQueue();
    q.offer('hud 999999 100 100 3 1', 0);
    assert.equal(text(q.next(0)), 'hud 999999 100 100 3');
    q.ack();
    assert.equal(text(q.next(0)), ' 1\n');
    q.fail();
    assert.equal(q.idle, false, 'the fragment still has to be closed');
    q.offer('hap 14', 0);
    assert.deepEqual(drain(q), ['\n', 'hap 14\n']);
    assert.equal(q.idle, true);
  });

  it('keeps trying to close the fragment if that write fails too', () => {
    const q = new WriteQueue({ chunkSize: 4 });
    q.offer('hello', 0);
    q.next(0);
    q.ack();
    q.next(0);
    q.fail();
    assert.equal(text(q.next(0)), '\n');
    q.fail();
    assert.deepEqual(drain(q), ['\n']);
  });

  it('clear() forgets everything, also the piece in flight', () => {
    const q = new WriteQueue();
    q.offer('hud 999999 100 100 3 1', 0);
    q.offer('hap 14', 0);
    q.offer('hello', 0);
    q.next(0);
    q.clear();
    assert.equal(q.idle, true);
    assert.equal(q.next(0), null);
    q.ack(); // the answer to the old piece must not disturb the new link
    q.offer('hello', 0);
    assert.deepEqual(drain(q), ['hello\n']);
  });
});
