import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LINK } from '../src/config.js';
import {
  HapticLimiter,
  HudScheduler,
  InputDecoder,
  LineSplitter,
  PHASE_CODE,
  formatHap,
  formatHello,
  formatHud,
  parseLine,
} from '../src/protocol.js';

const state = (k, t, z, h, m = -7500) => ({ type: 'state', k, t, z, h, m });

describe('parseLine', () => {
  it('parses the example from the contract', () => {
    assert.deepEqual(parseLine('!s -3 2 0 1 -6840'), { type: 'state', k: -3, t: 2, z: 0, h: 1, m: -6840 });
  });

  it('tolerates \\r\\n and trailing spaces', () => {
    assert.deepEqual(parseLine('!s 12 0 0 0 -7500\r'), state(12, 0, 0, 0));
    assert.deepEqual(parseLine('!s 12 0 0 0 -7500\r\n'), state(12, 0, 0, 0));
    assert.deepEqual(parseLine('!s 12 0 0 0 -7500  '), state(12, 0, 0, 0));
  });

  it('parses the handshake reply', () => {
    assert.deepEqual(parseLine('!hello ekko 1'), { type: 'hello', name: 'ekko', version: 1 });
    assert.deepEqual(parseLine('!hello ekko 2\r'), { type: 'hello', name: 'ekko', version: 2 });
  });

  it('ignores every line that does not start with "!"', () => {
    for (const line of [
      '',
      'I (1234) main: boot ok',
      '\u001b[0;32mI (312) cpu_start: Starting scheduler\u001b[0m',
      '> pong',
      '> state k=3 t=1',
      ' !s 1 2 3 4 -7000',
      's 1 2 3 4 -7000',
      'hello',
    ]) {
      assert.equal(parseLine(line), null, JSON.stringify(line));
    }
  });

  it('rejects garbage that does start with "!"', () => {
    for (const line of [
      '!',
      '!s',
      '!s 1 2 3 4',
      '!s 1 2 3 4 -7000 9',
      '!s a 2 3 4 -7000',
      '!s 1 2 3 4 loud',
      '!s 1.5 2 3 4 -7000',
      '!s 1 -2 3 4 -7000',
      '!s 1 2 -3 4 -7000',
      '!s 1 2 3 -4 -7000',
      '!s 1 2 3 4 -70e2',
      '!s 1 2 3 4 6840',
      '!s 1 2 3!s 1 2 3 4 -7000',
      '!s 12345678901234567890 2 3 4 -7000',
      '!x 1 2 3',
      '!hello',
      '!hello ekko',
      '!hello ekko one',
      '!state 1 2 3 4 -7000',
    ]) {
      assert.equal(parseLine(line), null, JSON.stringify(line));
    }
  });

  it('does not choke on things that are not strings', () => {
    assert.equal(parseLine(undefined), null);
    assert.equal(parseLine(null), null);
    assert.equal(parseLine(42), null);
  });

  it('clamps the mic level to the range of the contract', () => {
    assert.equal(parseLine('!s 0 0 0 0 -99999').m, -12000);
    assert.equal(parseLine('!s 0 0 0 0 150').m, 0);
    assert.equal(parseLine('!s 0 0 0 0 0').m, 0);
    assert.equal(parseLine('!s 0 0 0 0 -12000').m, -12000);
  });
});

describe('InputDecoder (events from counter differences)', () => {
  it('takes the first line as the baseline and fires nothing', () => {
    const d = new InputDecoder();
    assert.deepEqual(d.push(state(40, 7, 3, 2)), { events: [], resync: true });
  });

  it('fires nothing when nothing changed', () => {
    const d = new InputDecoder();
    d.push(state(5, 1, 1, 1));
    assert.deepEqual(d.push(state(5, 1, 1, 1, -3000)), { events: [], resync: false });
  });

  it('turns the knob difference into detents, both ways', () => {
    const d = new InputDecoder();
    d.push(state(-3, 0, 0, 0));
    assert.deepEqual(d.push(state(-1, 0, 0, 0)).events, [{ type: 'turn', detents: 2 }]);
    assert.deepEqual(d.push(state(-6, 0, 0, 0)).events, [{ type: 'turn', detents: -5 }]);
    assert.deepEqual(d.push(state(1, 0, 0, 0)).events, [{ type: 'turn', detents: 7 }]);
  });

  it('fires one event per counted tap, circle tap and long press', () => {
    const d = new InputDecoder();
    d.push(state(0, 0, 0, 0));
    assert.deepEqual(d.push(state(0, 1, 0, 0)).events, [{ type: 'tap' }]);
    assert.deepEqual(d.push(state(0, 1, 1, 0)).events, [{ type: 'flip' }]);
    assert.deepEqual(d.push(state(0, 1, 1, 1)).events, [{ type: 'hold' }]);
  });

  it('a counter that grew by n is n events (lines may have been lost)', () => {
    const d = new InputDecoder();
    d.push(state(0, 2, 0, 0));
    const { events } = d.push(state(4, 5, 2, 0));
    assert.deepEqual(events, [
      { type: 'turn', detents: 4 },
      { type: 'flip' },
      { type: 'flip' },
      { type: 'tap' },
      { type: 'tap' },
      { type: 'tap' },
    ]);
  });

  it('a counter that went down means a reboot: resynchronise without events', () => {
    for (const rebooted of [state(0, 0, 0, 0), state(2, 6, 0, 0), state(0, 9, 4, 0), state(0, 9, 5, 1)]) {
      const d = new InputDecoder();
      d.push(state(57, 9, 5, 2));
      const before = d.resyncs;
      assert.deepEqual(d.push(rebooted), { events: [], resync: true }, JSON.stringify(rebooted));
      assert.equal(d.resyncs, before + 1);
    }
  });

  it('continues from the new baseline after a reboot', () => {
    const d = new InputDecoder();
    d.push(state(57, 9, 5, 2));
    d.push(state(0, 0, 0, 0));
    assert.deepEqual(d.push(state(1, 1, 0, 0)).events, [{ type: 'turn', detents: 1 }, { type: 'tap' }]);
  });

  it('a knob that went down is just a knob turned anticlockwise, not a reboot', () => {
    const d = new InputDecoder();
    d.push(state(10, 3, 3, 3));
    assert.deepEqual(d.push(state(4, 3, 3, 3)), { events: [{ type: 'turn', detents: -6 }], resync: false });
  });

  it('a line that lost a digit cannot fire a burst of taps', () => {
    const d = new InputDecoder();
    d.push(state(0, 12, 0, 0));
    // "12" arrives as "2": looks like a reboot ...
    assert.deepEqual(d.push(state(0, 2, 0, 0)).events, []);
    // ... and the next intact line would look like ten taps.
    assert.deepEqual(d.push(state(0, 12, 0, 0)), { events: [], resync: true });
    assert.deepEqual(d.push(state(0, 13, 0, 0)).events, [{ type: 'tap' }]);
  });

  it('an impossible knob jump resynchronises instead of spinning the shield', () => {
    const d = new InputDecoder();
    d.push(state(900, 0, 0, 0));
    assert.deepEqual(d.push(state(0, 0, 0, 0)), { events: [], resync: true });
    assert.deepEqual(d.push(state(LINK.MAX_DETENTS_PER_LINE, 0, 0, 0)).events, [
      { type: 'turn', detents: LINK.MAX_DETENTS_PER_LINE },
    ]);
  });

  it('reset() forgets the baseline', () => {
    const d = new InputDecoder();
    d.push(state(0, 0, 0, 0));
    d.reset();
    assert.deepEqual(d.push(state(0, 3, 0, 0)), { events: [], resync: true });
  });

  it('ignores anything that is not a state message', () => {
    const d = new InputDecoder();
    assert.deepEqual(d.push({ type: 'hello', name: 'ekko', version: 1 }), { events: [], resync: false });
    assert.deepEqual(d.push(null), { events: [], resync: false });
    assert.deepEqual(d.push(state(3, 1, 0, 0)), { events: [], resync: true }, 'still the first state line');
  });

  it('works end to end from raw lines', () => {
    const d = new InputDecoder();
    const lines = ['I (10) boot: hi', '!s 0 0 0 0 -7500', '!s 2 0 0 0 -7400', 'garbage', '!s 2 1 0 0 -2000\r'];
    const events = lines.flatMap((line) => d.push(parseLine(line)).events);
    assert.deepEqual(events, [{ type: 'turn', detents: 2 }, { type: 'tap' }]);
  });
});

describe('formatting host -> device lines', () => {
  it('formats hello', () => {
    assert.equal(formatHello(), 'hello');
  });

  it('formats the hud example from the contract', () => {
    assert.equal(formatHud({ score: 1250, health: 80, breath: 35, phase: 'playing', polarity: 1 }), 'hud 1250 80 35 1 1');
  });

  it('maps the phases to 0..3', () => {
    assert.deepEqual(PHASE_CODE, { ready: 0, playing: 1, paused: 2, over: 3 });
    const phaseOf = (phase) => formatHud({ score: 0, health: 100, breath: 100, phase, polarity: 0 }).split(' ')[4];
    assert.deepEqual(['ready', 'playing', 'paused', 'over'].map(phaseOf), ['0', '1', '2', '3']);
  });

  it('sends integers inside the ranges of the contract', () => {
    assert.equal(formatHud({ score: 1234567, health: 140, breath: 100.4, phase: 'over', polarity: 0 }), 'hud 999999 100 100 3 0');
    assert.equal(formatHud({ score: -5, health: -3, breath: -1, phase: 'ready', polarity: 0 }), 'hud 0 0 0 0 0');
    assert.equal(formatHud({ score: 10.6, health: 63.5, breath: 49.5, phase: 'paused', polarity: 1 }), 'hud 11 64 50 2 1');
    assert.equal(formatHud({ score: NaN, health: NaN, breath: undefined, phase: 'nope', polarity: undefined }), 'hud 0 0 0 0 0');
  });

  it('never shows a living core as 0 health', () => {
    assert.equal(formatHud({ score: 0, health: 0.2, breath: 0, phase: 'playing', polarity: 1 }), 'hud 0 1 0 1 1');
    assert.equal(formatHud({ score: 0, health: 0, breath: 0, phase: 'over', polarity: 1 }), 'hud 0 0 0 3 1');
  });

  it('formats hap for waveforms 1..123 only', () => {
    assert.equal(formatHap(1), 'hap 1');
    assert.equal(formatHap(123), 'hap 123');
    for (const bad of [0, 124, -1, 1.5, NaN, '14', null, undefined]) assert.equal(formatHap(bad), null);
  });
});

describe('HudScheduler (rate limit and heartbeat)', () => {
  it('sends the first line at once', () => {
    const s = new HudScheduler();
    assert.equal(s.poll('hud 0 100 100 0 1', 5000), 'hud 0 100 100 0 1');
  });

  it('does not repeat an unchanged line until the heartbeat is due', () => {
    const s = new HudScheduler();
    s.poll('a', 0);
    assert.equal(s.poll('a', 50), null);
    assert.equal(s.poll('a', LINK.HUD_HEARTBEAT_MS - 1), null);
    assert.equal(s.poll('a', LINK.HUD_HEARTBEAT_MS), 'a');
    assert.equal(s.poll('a', LINK.HUD_HEARTBEAT_MS + 10), null);
  });

  it('holds a change back until the minimum interval has passed, then sends the latest value', () => {
    const min = LINK.HUD_MIN_INTERVAL_MS;
    assert.ok(min >= 100, 'the contract allows at most 10 lines a second');
    const s = new HudScheduler();
    s.poll('a', 0);
    assert.equal(s.poll('b', 30), null);
    assert.equal(s.poll('c', min - 1), null);
    assert.equal(s.poll('d', min), 'd');
    assert.equal(s.poll('d', min + 50), null);
  });

  it('stays within the contract when the state changes on every frame', () => {
    const s = new HudScheduler();
    const sent = [];
    for (let now = 0; now <= 5000; now += 16) {
      if (s.poll(`hud ${now}`, now) !== null) sent.push(now);
    }
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 100, 'never closer than 100 ms');
    for (let second = 0; second < 5; second++) {
      const inWindow = sent.filter((t) => t >= second * 1000 && t < (second + 1) * 1000).length;
      assert.ok(inWindow <= 10, `at most 10 per second, got ${inWindow}`);
    }
    assert.ok(sent.length >= 40, 'but changes do get through');
  });

  it('keeps the heartbeat under one second when nothing changes', () => {
    assert.ok(LINK.HUD_HEARTBEAT_MS < 1000);
    const s = new HudScheduler();
    const sent = [];
    for (let now = 0; now <= 10_000; now += 16) {
      if (s.poll('same', now) !== null) sent.push(now);
    }
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] <= 1000);
    assert.ok(sent.length >= 10);
  });

  it('reset() makes the next poll send (new connection)', () => {
    const s = new HudScheduler();
    s.poll('a', 0);
    s.reset();
    assert.equal(s.poll('a', 1), 'a');
  });
});

describe('HapticLimiter', () => {
  it('lets a single effect through at once', () => {
    const h = new HapticLimiter();
    h.offer(24, 1, 1000);
    assert.equal(h.poll(1000), 24);
    assert.equal(h.poll(1001), null);
  });

  it('keeps effects further apart than the 60 ms the device needs', () => {
    assert.ok(LINK.HAP_MIN_GAP_MS > 60);
    const h = new HapticLimiter();
    const sent = [];
    for (let now = 0; now < 2000; now += 16) {
      h.offer(24, 1, now);
      if (h.poll(now) !== null) sent.push(now);
    }
    assert.ok(sent.length > 10);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] > 60);
  });

  it('plays a waiting effect as soon as the gap has passed', () => {
    const h = new HapticLimiter();
    h.offer(24, 1, 0);
    assert.equal(h.poll(0), 24);
    h.offer(1, 2, 10);
    assert.equal(h.poll(10), null);
    assert.equal(h.poll(LINK.HAP_MIN_GAP_MS - 1), null);
    assert.equal(h.poll(LINK.HAP_MIN_GAP_MS), 1);
  });

  it('of two waiting effects the more important one survives', () => {
    const h = new HapticLimiter();
    h.offer(24, 1, 0);
    h.poll(0);
    h.offer(24, 1, 5); // absorb
    h.offer(12, 5, 6); // game over
    h.offer(14, 3, 7); // core hit
    assert.equal(h.poll(LINK.HAP_MIN_GAP_MS), 12);
    assert.equal(h.poll(LINK.HAP_MIN_GAP_MS * 2), null);
    assert.equal(h.dropped, 2);
    assert.equal(h.sent, 2);
  });

  it('in the same frame the most important effect is the one that plays', () => {
    const h = new HapticLimiter();
    h.offer(14, 3, 500);
    h.offer(12, 5, 500);
    assert.equal(h.poll(500), 12);
  });

  it('drops an effect that waited too long', () => {
    const h = new HapticLimiter();
    h.offer(24, 1, 0);
    assert.equal(h.poll(LINK.HAP_MAX_AGE_MS + 1), null);
    assert.equal(h.poll(LINK.HAP_MAX_AGE_MS + 500), null);
    assert.equal(h.dropped, 1);
  });

  it('ignores effect numbers the device cannot play', () => {
    const h = new HapticLimiter();
    for (const bad of [0, 124, 2.5, NaN, undefined]) h.offer(bad, 9, 0);
    assert.equal(h.poll(0), null);
  });
});

describe('LineSplitter', () => {
  it('splits on \\n and strips \\r', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push('!s 1 0 0 0 -7500\r\n!hello ekko 1\n'), ['!s 1 0 0 0 -7500', '!hello ekko 1']);
  });

  it('joins lines that arrive in pieces', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push('!s 1 0'), []);
    assert.deepEqual(s.push(' 0 0 -75'), []);
    assert.deepEqual(s.push('00\r'), []);
    assert.deepEqual(s.push('\n!s 2'), ['!s 1 0 0 0 -7500']);
    assert.deepEqual(s.push(' 0 0 0 -7400\n'), ['!s 2 0 0 0 -7400']);
  });

  it('keeps empty lines as empty strings', () => {
    assert.deepEqual(new LineSplitter().push('\n\r\nx\n'), ['', '', 'x']);
  });

  it('drops an over-long line completely, then recovers', () => {
    const s = new LineSplitter(16);
    assert.deepEqual(s.push('x'.repeat(40)), []);
    assert.deepEqual(s.push('!s tail of the long line\n!s 1 0 0 0 -1\n'), ['!s 1 0 0 0 -1']);
    assert.deepEqual(s.push(`${'y'.repeat(30)}\nok\n`), ['ok']);
  });

  it('reset() discards a half-received line', () => {
    const s = new LineSplitter();
    s.push('!s 1 0 0');
    s.reset();
    assert.deepEqual(s.push('!s 2 0 0 0 -7500\n'), ['!s 2 0 0 0 -7500']);
  });
});
