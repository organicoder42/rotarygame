// Every tuning constant of the game lives in this file.
// Units: distances are fractions of the arena radius (rim = 1), angles are
// degrees (0 = up, clockwise positive, like the knob), times are seconds unless
// the name says _MS, sound levels are centi-dB (cdB, 100 cdB = 1 dB).

/** Knob feel. */
export const CONTROL = Object.freeze({
  /** Degrees the shield turns per knob detent. The real detent count per
   *  revolution is not known yet: 12 assumes 30 detents per turn. */
  DETENT_DEG: 12,
  /** How fast the drawn shield chases its target angle (1/s, exponential). */
  SHIELD_FOLLOW_PER_S: 22,
});

/** Geometry of the round arena. */
export const ARENA = Object.freeze({
  RIM_R: 1,
  CORE_R: 0.075,
  SHIELD_R: 0.215,
  /** Half the angular width of the shield arc. */
  SHIELD_HALF_ARC_DEG: 30,
  /** Extra forgiveness at the shield's ends (covers the spark's own size). */
  SHIELD_TOLERANCE_DEG: 4,
});

/** Game rules and difficulty curve. */
export const RULES = Object.freeze({
  HEALTH_MAX: 100,
  CORE_DAMAGE: 12,
  SCORE_MAX: 999999,

  /** No sparks spawn for this long after start (the mic calibrates meanwhile). */
  START_GRACE_S: 1.6,
  /** Seconds of play until the "END" values below are reached. */
  RAMP_S: 100,
  /** Speed keeps growing past RAMP_S up to this multiple of the ramp. */
  MAX_DIFFICULTY: 1.6,

  SPAWN_INTERVAL_START_S: 1.5,
  SPAWN_INTERVAL_END_S: 0.45,
  SPARK_SPEED_START: 0.15,
  SPARK_SPEED_END: 0.3,
  /** A new spark appears within +-this many degrees of the previous one. */
  SPAWN_SPREAD_START_DEG: 70,
  SPAWN_SPREAD_END_DEG: 150,
  /** Chance (at full difficulty) that a spark ignores the spread entirely. */
  WILD_SPAWN_CHANCE_END: 0.2,
  /** Chance that a spark repeats the previous spark's polarity. */
  SAME_POLARITY_START: 0.78,
  SAME_POLARITY_END: 0.5,
  /** Sideways drift of late sparks, degrees per second. */
  DRIFT_MAX_DEG_S: 10,
  MAX_SPARKS: 60,

  ABSORB_POINTS: 10,
  /** Every this many absorbs in a row raise the multiplier by one. */
  COMBO_PER_MULT: 4,
  MULT_MAX: 8,
  BOLT_POINTS: 5,
  SHOCK_POINTS: 2,

  BOLT_SPEED: 2.6,
  BOLT_COOLDOWN_S: 0.35,
  /** Half-width of the bolt's path. The rules never let it be narrower than
   *  0.6 detents, so every spark can be hit from some knob position. */
  BOLT_HALF_WIDTH_DEG: 7,

  BREATH_MAX: 100,
  /** Calibrated mic level (0..1) below which the room counts as silent. */
  BREATH_MIN_LEVEL: 0.08,
  /** Breath lost per second at mic level 1 (scales with the level). */
  BREATH_DRAIN_PER_S: 36,
  BREATH_REFILL_PER_S: 14,
  /** Outward speed given to a spark at the core at mic level 1. */
  PUSH_SPEED: 0.6,
  /** Share of the push that is lost at the rim (0 = same force everywhere). */
  PUSH_FALLOFF: 0.5,

  SHOCK_COST: 50,
  SHOCK_RADIUS: 0.62,
  SHOCK_SPEED: 2.2,
});

/** Microphone calibration. Raw values are centi-dBFS from the device. */
export const MIC = Object.freeze({
  /** At or below this the device reports "digital silence or no mic". */
  NO_MIC_CDB: -11900,
  /** How long the floor is measured when a game starts. */
  CALIBRATION_MS: 1500,
  CALIBRATION_MIN_SAMPLES: 5,
  /** Level 0 sits this far above the noise floor ... */
  MARGIN_CDB: 1000,
  /** ... and level 1 this far above it. */
  SPAN_CDB: 3500,
  /** Level 1 is never placed above this (keeps it reachable in a loud room). */
  CEILING_CDB: -300,
  /** Smallest allowed distance between level 0 and level 1. */
  MIN_RANGE_CDB: 1000,
  FLOOR_MIN_CDB: -9500,
  FLOOR_MAX_CDB: -2500,
  /** Floor tracking speed while the room is quiet (within the margin). */
  FLOOR_RISE_CDB_S: 150,
  FLOOR_FALL_CDB_S: 150,
  /** Floor tracking speed while somebody is making noise (much slower, so a
   *  long blow is not mistaken for a louder room). */
  FLOOR_RISE_ACTIVE_CDB_S: 30,
  /** How fast the smoothed level falls after the sound stops (per second). */
  RELEASE_PER_S: 5,
  /** A clap = one sample jumps from at most PREV_MAX to at least MIN_LEVEL. */
  CLAP_MIN_LEVEL: 0.7,
  CLAP_PREV_MAX: 0.3,
  CLAP_REFRACTORY_MS: 450,
});

/** Keyboard stand-ins for the microphone. */
export const KEYBOARD_MIC = Object.freeze({
  /** Simulated quiet room when no device is connected. */
  QUIET_CDB: -7500,
  JITTER_CDB: 60,
  /** Calibrated level produced by holding M (must stay below CLAP_MIN_LEVEL). */
  BLOW_LEVEL: 0.65,
  /** Calibrated level produced by tapping N (above 1 = certain clap). */
  CLAP_LEVEL: 1.2,
  SAMPLE_MS: 40,
});

/** DRV2605L library waveforms. Believed correct, not yet verified by feel. */
export const WAVEFORM = Object.freeze({
  STRONG_CLICK: 1,
  SOFT_BUMP: 7,
  DOUBLE_CLICK: 10,
  TRIPLE_CLICK: 12,
  STRONG_BUZZ: 14,
  SHARP_TICK: 24,
});

/** Which waveform each game event plays (0 = no cue) and which one wins when
 *  two fall inside the same rate-limit window (higher priority wins). */
export const HAPTIC_CUES = Object.freeze({
  absorb: { effect: WAVEFORM.SHARP_TICK, priority: 1 },
  boltKill: { effect: WAVEFORM.STRONG_CLICK, priority: 2 },
  coreHit: { effect: WAVEFORM.STRONG_BUZZ, priority: 3 },
  shockwave: { effect: WAVEFORM.DOUBLE_CLICK, priority: 4 },
  gameOver: { effect: WAVEFORM.TRIPLE_CLICK, priority: 5 },
  flip: { effect: 0, priority: 0 },
});

/** Serial link and the rate limits of PROTOCOL.md. */
export const LINK = Object.freeze({
  USB_VENDOR_ID: 0x303a,
  BAUD_RATE: 115200,
  PROTOCOL_VERSION: 1,
  DEVICE_NAME: 'ekko',
  HELLO_RETRY_MS: 700,
  /** Contract: hud at most 10 times a second ... */
  HUD_MIN_INTERVAL_MS: 105,
  /** ... and at least once a second (sent a little early to absorb jitter). */
  HUD_HEARTBEAT_MS: 900,
  /** Contract: the device drops effects closer than 60 ms apart. */
  HAP_MIN_GAP_MS: 70,
  /** A cue that waited longer than this is no longer worth playing. */
  HAP_MAX_AGE_MS: 250,
  /** Jumps larger than these in a single line are treated as a resync
   *  (reboot or a corrupted line), not as real input. */
  MAX_DETENTS_PER_LINE: 120,
  MAX_COUNT_STEP: 8,
  MAX_LINE_LENGTH: 512,
});
