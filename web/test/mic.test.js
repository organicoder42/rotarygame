import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIC } from '../src/config.js';
import { createMic, micBeginCalibration, micIsCalibrating, micRange, micRawForLevel, micSample } from '../src/mic.js';

const PERIOD = 40; // the device sends about 25 lines a second

/** Feeds samples 40 ms apart; `raw` may be a number or a function of the index. */
function feed(mic, startMs, count, raw) {
  let m = mic;
  let level = 0;
  let claps = 0;
  let now = startMs;
  for (let i = 0; i < count; i++) {
    const out = micSample(m, typeof raw === 'function' ? raw(i) : raw, now);
    m = out.mic;
    level = out.level;
    if (out.clap) claps += 1;
    now += PERIOD;
  }
  return { mic: m, level, claps, now };
}

/** A room with a little jitter around `floor`, deterministic. */
const room = (floor, jitter = 80) => (i) => floor + Math.round(Math.sin(i * 1.7) * jitter);

/** A calibrated microphone in a room whose noise floor is `floor`. */
function calibrated(floor = -7500) {
  const begun = micBeginCalibration(createMic(), 0);
  const samples = Math.ceil(MIC.CALIBRATION_MS / PERIOD) + 2;
  return feed(begun, 0, samples, room(floor));
}

describe('noise floor calibration', () => {
  it('measures the floor at game start and reads 0 meanwhile', () => {
    let mic = micBeginCalibration(createMic(), 0);
    assert.equal(micIsCalibrating(mic), true);
    const during = feed(mic, 0, 20, -4000); // even loud samples read as 0 for now
    assert.equal(during.level, 0);
    assert.equal(during.claps, 0);
    assert.equal(micIsCalibrating(during.mic), true);

    const done = calibrated(-7500);
    assert.equal(micIsCalibrating(done.mic), false);
    assert.ok(Math.abs(done.mic.floor - -7500) < 120, `floor ${done.mic.floor}`);
    assert.equal(done.level, 0);
  });

  it('adapts to a noisy room instead of using absolute numbers', () => {
    const quietRoom = calibrated(-7500);
    const workshop = calibrated(-5200);
    assert.ok(Math.abs(workshop.mic.floor - -5200) < 120);

    // The same ambient noise reads as silence in both rooms ...
    assert.equal(feed(quietRoom.mic, quietRoom.now, 25, room(-7500)).level, 0);
    assert.equal(feed(workshop.mic, workshop.now, 25, room(-5200)).level, 0);
    // ... and the same distance above the floor reads as the same level.
    const a = micSample(quietRoom.mic, -7500 + 2200, quietRoom.now).level;
    const b = micSample(workshop.mic, -5200 + 2200, workshop.now).level;
    assert.ok(a > 0.3 && Math.abs(a - b) < 0.08, `${a} vs ${b}`);
  });

  it('uses the median, so one bang during calibration does not spoil it', () => {
    const begun = micBeginCalibration(createMic(), 0);
    const out = feed(begun, 0, 45, (i) => (i === 10 ? -1500 : -7500));
    assert.equal(out.mic.floor, -7500);
  });

  it('keeps the old floor when too few samples arrived', () => {
    const before = calibrated(-7000);
    let mic = micBeginCalibration(before.mic, 10_000);
    mic = micSample(mic, -3000, 10_010).mic;
    const out = micSample(mic, -7000, 10_000 + MIC.CALIBRATION_MS + 10);
    assert.equal(micIsCalibrating(out.mic), false);
    assert.ok(Math.abs(out.mic.floor - before.mic.floor) < 50);
  });

  it('takes the first sample as a provisional floor before any calibration', () => {
    const out = feed(createMic(), 0, 10, room(-6800, 30));
    assert.ok(Math.abs(out.mic.floor - -6800) < 60);
    assert.equal(out.level, 0);
  });
});

describe('level mapping', () => {
  it('maps floor + margin .. floor + span onto 0 .. 1', () => {
    const { mic, now } = calibrated(-7500);
    const floor = mic.floor;
    const at = (offset) => micSample(mic, floor + offset, now).level;
    assert.equal(at(0), 0);
    assert.equal(at(MIC.MARGIN_CDB - 50), 0, 'inside the margin is still silence');
    const mid = at((MIC.MARGIN_CDB + MIC.SPAN_CDB) / 2);
    assert.ok(Math.abs(mid - 0.5) < 0.03, `mid ${mid}`);
    assert.ok(at(MIC.SPAN_CDB) > 0.97);
    assert.equal(at(MIC.SPAN_CDB + 3000), 1);
  });

  it('grows with loudness', () => {
    const { mic, now } = calibrated(-7500);
    let last = -1;
    for (let raw = -6500; raw <= -4000; raw += 250) {
      const level = micSample(mic, raw, now).level;
      assert.ok(level >= last);
      last = level;
    }
    assert.ok(last > 0.9);
  });

  it('keeps full scale reachable in a very loud room', () => {
    const { bottom, top } = micRange(MIC.FLOOR_MAX_CDB);
    assert.ok(top <= MIC.CEILING_CDB);
    assert.ok(top - bottom >= MIC.MIN_RANGE_CDB);
    const loudRoom = calibrated(-1000); // louder than the tracker allows
    assert.equal(loudRoom.mic.floor, MIC.FLOOR_MAX_CDB);
    assert.equal(micSample(loudRoom.mic, 0, loudRoom.now).level, 1);
  });

  it('rises at once and falls gradually', () => {
    const { mic, now } = calibrated(-7500);
    const loud = micSample(mic, -3000, now);
    assert.equal(loud.level, 1);
    const after = micSample(loud.mic, -7500, now + PERIOD);
    assert.ok(after.level > 0.5 && after.level < 1, `one sample later: ${after.level}`);
    assert.equal(feed(after.mic, now + 2 * PERIOD, 15, -7500).level, 0);
  });

  it('micRawForLevel is the inverse of the mapping', () => {
    const { mic, now } = calibrated(-6000);
    for (const level of [0.2, 0.65, 1]) {
      const raw = micRawForLevel(mic, level);
      assert.ok(Math.abs(micSample(mic, raw, now).level - level) < 0.02);
    }
  });
});

describe('floor tracking while playing', () => {
  it('follows the room when it slowly gets louder or quieter', () => {
    const start = calibrated(-7500);
    const louder = feed(start.mic, start.now, 25 * 20, (i) => -7500 + Math.min(600, i * 2) + Math.round(Math.sin(i) * 60));
    assert.ok(Math.abs(louder.mic.floor - -6900) < 150, `floor ${louder.mic.floor}`);
    assert.equal(louder.level, 0);

    const quieter = feed(louder.mic, louder.now, 25 * 10, room(-7800));
    assert.ok(Math.abs(quieter.mic.floor - -7800) < 150, `floor ${quieter.mic.floor}`);
  });

  it('does not mistake a long blow for a louder room', () => {
    const start = calibrated(-7500);
    const blown = feed(start.mic, start.now, 25 * 4, -3500); // four seconds of blowing
    assert.equal(blown.level, 1);
    assert.ok(blown.mic.floor - start.mic.floor < 200, `floor rose ${blown.mic.floor - start.mic.floor} cdB`);
  });

  it('recovers when the room really did get much louder', () => {
    const start = calibrated(-7500);
    const stuck = feed(start.mic, start.now, 25 * 60, room(-6000));
    assert.ok(stuck.level < 0.1, `level ${stuck.level} after a minute`);
  });

  it('ignores "digital silence / no mic" instead of dragging the floor down', () => {
    const start = calibrated(-7500);
    const silent = feed(start.mic, start.now, 50, -12000);
    assert.equal(silent.mic.valid, false);
    assert.equal(silent.level, 0);
    assert.equal(silent.mic.floor, start.mic.floor);
    assert.equal(feed(createMic(), 0, 20, -12000).mic.floor, null);
    assert.equal(micSample(start.mic, NaN, start.now).level, 0);
  });
});

describe('clap detection', () => {
  it('fires on one sudden loud sample, once', () => {
    const { mic, now } = calibrated(-7500);
    const out = feed(mic, now, 12, (i) => (i === 3 ? -2500 : -7500));
    assert.equal(out.claps, 1);
    assert.equal(out.mic.claps, 1);
  });

  it('works the same in a noisy room', () => {
    const { mic, now } = calibrated(-5200);
    const out = feed(mic, now, 12, (i) => (i === 3 ? -1200 : room(-5200)(i)));
    assert.equal(out.claps, 1);
  });

  it('does not fire on a breath that ramps up over a few samples', () => {
    const { mic, now } = calibrated(-7500);
    const ramp = [-7500, -6200, -5200, -4300, -3600, -3200, -3200, -3200, -3200];
    assert.equal(feed(mic, now, ramp.length, (i) => ramp[i]).claps, 0);
  });

  it('does not fire while it is already loud', () => {
    const { mic, now } = calibrated(-7500);
    const out = feed(mic, now, 20, (i) => (i < 3 ? -7500 : i === 10 ? -2000 : -5000));
    assert.equal(out.claps, 0);
  });

  it('does not fire on a peak that is not loud enough', () => {
    const { mic, now } = calibrated(-7500);
    const out = feed(mic, now, 12, (i) => (i === 3 ? -5600 : -7500));
    assert.equal(out.claps, 0);
  });

  it('has a refractory period, then fires again', () => {
    const { mic, now } = calibrated(-7500);
    // Two peaks 80 ms apart, then one well after the refractory period.
    const far = Math.ceil(MIC.CLAP_REFRACTORY_MS / PERIOD) + 6;
    const out = feed(mic, now, far + 4, (i) => (i === 2 || i === 4 || i === far ? -2500 : -7500));
    assert.equal(out.claps, 2);
  });

  it('never fires during calibration', () => {
    const begun = micBeginCalibration(calibrated(-7500).mic, 5000);
    const out = feed(begun, 5000, 20, (i) => (i % 5 === 0 ? -2000 : -7500));
    assert.equal(out.claps, 0);
  });
});

describe('purity', () => {
  it('does not mutate the state it is given', () => {
    const { mic, now } = calibrated(-7500);
    const frozen = Object.freeze({ ...mic, calibSamples: Object.freeze([...mic.calibSamples]) });
    assert.doesNotThrow(() => micSample(frozen, -3000, now));
    assert.doesNotThrow(() => micSample(Object.freeze(micBeginCalibration(frozen, now)), -3000, now + 10));
  });
});
