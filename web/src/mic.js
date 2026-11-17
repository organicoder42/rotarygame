// Microphone calibration. Pure: raw centi-dBFS samples and timestamps in,
// a calibrated 0..1 level and clap detection out.
//
// The absolute numbers from the device are not calibrated and the room is
// noisy, so nothing here is an absolute threshold: the noise floor is measured
// when a game starts, tracked slowly afterwards, and the level is the distance
// above that floor (floor + MARGIN -> 0, floor + SPAN -> 1).

import { MIC } from './config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A microphone that has heard nothing yet. */
export function createMic() {
  return {
    /** Noise floor in cdB, null until the first valid sample. */
    floor: null,
    /** Smoothed level 0..1 (instant attack, gradual release). */
    level: 0,
    /** Level of the latest sample alone, 0..1. */
    inst: 0,
    /** Latest raw sample in cdB. */
    raw: null,
    /** False while the device reports digital silence / no microphone. */
    valid: false,
    lastT: null,
    /** Timestamp (ms) at which the running calibration ends, or null. */
    calibUntil: null,
    calibSamples: [],
    lastClapT: -Infinity,
    claps: 0,
  };
}

/** Starts measuring the noise floor; the level reads 0 until it is done. */
export function micBeginCalibration(mic, now) {
  return { ...mic, calibUntil: now + MIC.CALIBRATION_MS, calibSamples: [], level: 0, inst: 0 };
}

/** True while the floor is being measured. */
export function micIsCalibrating(mic) {
  return mic.calibUntil !== null;
}

/** The raw values that map to level 0 and level 1 for a given floor. */
export function micRange(floor) {
  const top = Math.min(floor + MIC.SPAN_CDB, MIC.CEILING_CDB);
  const bottom = Math.min(floor + MIC.MARGIN_CDB, top - MIC.MIN_RANGE_CDB);
  return { bottom, top };
}

/** The raw cdB value that would read as `level` right now (keyboard stand-in). */
export function micRawForLevel(mic, level) {
  const { bottom, top } = micRange(mic.floor ?? MIC.FLOOR_MIN_CDB);
  return Math.round(bottom + level * (top - bottom));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Feeds one raw sample (centi-dBFS) taken at `now` (ms).
 * Returns { mic, level, clap }: the new state, the smoothed level 0..1 and
 * whether this sample was a clap.
 */
export function micSample(prev, raw, now) {
  const mic = { ...prev };
  const dt = mic.lastT === null ? 0.04 : clamp((now - mic.lastT) / 1000, 0, 0.25);
  mic.lastT = now;
  mic.raw = raw;

  // A calibration that has run its time ends even if samples were missing.
  let justCalibrated = false;
  if (mic.calibUntil !== null && now >= mic.calibUntil) {
    if (mic.calibSamples.length >= MIC.CALIBRATION_MIN_SAMPLES) {
      mic.floor = clamp(median(mic.calibSamples), MIC.FLOOR_MIN_CDB, MIC.FLOOR_MAX_CDB);
    }
    mic.calibUntil = null;
    mic.calibSamples = [];
    justCalibrated = true;
  }

  const valid = Number.isFinite(raw) && raw > MIC.NO_MIC_CDB;
  mic.valid = valid;
  if (!valid) {
    mic.inst = 0;
    mic.level = Math.max(0, mic.level - MIC.RELEASE_PER_S * dt);
    return { mic, level: mic.level, clap: false };
  }

  if (mic.floor === null) mic.floor = clamp(raw, MIC.FLOOR_MIN_CDB, MIC.FLOOR_MAX_CDB);

  if (mic.calibUntil !== null) {
    mic.calibSamples = [...mic.calibSamples, raw];
    mic.inst = 0;
    mic.level = 0;
    return { mic, level: 0, clap: false };
  }

  // Track the floor: symmetric while quiet (settles near the median of the
  // room noise), very slowly upwards while somebody is making noise.
  const above = raw - mic.floor;
  if (above < 0) {
    mic.floor = Math.max(raw, mic.floor - MIC.FLOOR_FALL_CDB_S * dt);
  } else if (above <= MIC.MARGIN_CDB) {
    mic.floor = Math.min(raw, mic.floor + MIC.FLOOR_RISE_CDB_S * dt);
  } else {
    mic.floor += MIC.FLOOR_RISE_ACTIVE_CDB_S * dt;
  }
  mic.floor = clamp(mic.floor, MIC.FLOOR_MIN_CDB, MIC.FLOOR_MAX_CDB);

  const { bottom, top } = micRange(mic.floor);
  const inst = clamp((raw - bottom) / (top - bottom), 0, 1);

  // A clap is one sample that jumps from (near) quiet to loud. A breath ramps
  // up over several samples and so does not qualify.
  const clap =
    !justCalibrated &&
    inst >= MIC.CLAP_MIN_LEVEL &&
    mic.inst <= MIC.CLAP_PREV_MAX &&
    now - mic.lastClapT >= MIC.CLAP_REFRACTORY_MS;
  if (clap) {
    mic.lastClapT = now;
    mic.claps += 1;
  }

  mic.inst = inst;
  mic.level = Math.max(inst, mic.level - MIC.RELEASE_PER_S * dt);
  return { mic, level: mic.level, clap };
}
