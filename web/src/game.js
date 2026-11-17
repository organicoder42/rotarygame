// Ekko game rules. Pure: no DOM, canvas, timers, serial or Math.random.
//
//   step(state, events, dt) -> { state, effects }
//
// `state` is never mutated; the random generator's seed is part of the state,
// so the same state + events + dt always give the same result.
//
// Events in (from the knob, the keyboard and the microphone):
//   { type: 'turn', detents }  knob moved, clockwise positive
//   { type: 'tap' }            fire a bolt
//   { type: 'flip' }           flip the shield's polarity
//   { type: 'hold' }           start / pause / resume / restart
//   { type: 'pause' }          pause if playing (tab hidden, cable pulled)
//   { type: 'mic', level }     calibrated loudness 0..1, kept until the next one
//   { type: 'clap' }           sudden loud peak
//
// Effects out (for haptics, particles and messages):
//   start, pause, resume, flip, fire, pass, absorb, boltKill, shockwave,
//   shockDenied, shockKill, breathOut, coreHit, gameOver

import { ARENA, CONTROL, RULES } from './config.js';

export const PHASE = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a * (1 - t) + b * t;

/** Wraps an angle in degrees to [-180, 180). */
export function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** Signed shortest difference a - b in degrees. */
export function angleDiff(a, b) {
  return wrapDeg(a - b);
}

/** Score multiplier for a combo of consecutive absorbs. */
export function multiplier(combo) {
  return Math.min(1 + Math.floor(combo / RULES.COMBO_PER_MULT), RULES.MULT_MAX);
}

/** 0 at the start, 1 after RULES.RAMP_S of play, capped at MAX_DIFFICULTY. */
export function difficulty(time) {
  return clamp((time - RULES.START_GRACE_S) / RULES.RAMP_S, 0, RULES.MAX_DIFFICULTY);
}

/** Half-width of a bolt's path: never narrower than 0.6 detents. */
export function boltHalfWidthDeg() {
  return Math.max(RULES.BOLT_HALF_WIDTH_DEG, CONTROL.DETENT_DEG * 0.6);
}

/** Seconds between spawns at a given play time (before random jitter). */
export function spawnInterval(time) {
  const d = Math.min(difficulty(time), 1);
  return lerp(RULES.SPAWN_INTERVAL_START_S, RULES.SPAWN_INTERVAL_END_S, d);
}

/** Inward speed of a spark spawned at a given play time (before jitter). */
export function sparkSpeed(time) {
  return lerp(RULES.SPARK_SPEED_START, RULES.SPARK_SPEED_END, difficulty(time));
}

/** A fresh game in the "ready" phase. */
export function createGame(seed = 1) {
  return {
    phase: PHASE.READY,
    seed: seed >>> 0,
    time: 0,
    score: 0,
    health: RULES.HEALTH_MAX,
    breath: RULES.BREATH_MAX,
    combo: 0,
    bestCombo: 0,
    polarity: 1,
    shieldTarget: 0,
    shieldAngle: 0,
    mic: 0,
    blowing: false,
    cooldown: 0,
    spawnIn: RULES.START_GRACE_S,
    spawned: 0,
    lastSpawnAngle: 0,
    lastSpawnPolarity: 1,
    nextId: 1,
    sparks: [],
    bolts: [],
    shocks: [],
    stats: { absorbed: 0, bolted: 0, shocked: 0, hits: 0 },
  };
}

/** Advances the game. See the top of the file for events and effects. */
export function step(prev, events = [], dt = 0) {
  const s = cloneState(prev);
  const effects = [];
  for (const event of events) applyEvent(s, event, effects);
  if (dt > 0) advance(s, dt, effects);
  return { state: s, effects };
}

function cloneState(p) {
  return {
    ...p,
    sparks: p.sparks.map((x) => ({ ...x })),
    bolts: p.bolts.map((x) => ({ ...x })),
    shocks: p.shocks.map((x) => ({ ...x })),
    stats: { ...p.stats },
  };
}

// mulberry32; the seed lives in the state so the rules stay deterministic.
function rand(s) {
  s.seed = (s.seed + 0x6d2b79f5) >>> 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function startRun(s) {
  const fresh = createGame(s.seed);
  // The player keeps what their hands already set up.
  fresh.polarity = s.polarity;
  fresh.shieldTarget = s.shieldTarget;
  fresh.shieldAngle = s.shieldAngle;
  fresh.mic = s.mic;
  fresh.lastSpawnAngle = s.shieldTarget;
  fresh.phase = PHASE.PLAYING;
  Object.assign(s, fresh);
}

function applyEvent(s, e, fx) {
  if (!e || typeof e.type !== 'string') return;

  if (e.type === 'mic') {
    s.mic = Number.isFinite(e.level) ? clamp(e.level, 0, 1) : 0;
    return;
  }
  if (e.type === 'hold') {
    if (s.phase === PHASE.READY || s.phase === PHASE.OVER) {
      startRun(s);
      fx.push({ type: 'start' });
    } else if (s.phase === PHASE.PLAYING) {
      s.phase = PHASE.PAUSED;
      fx.push({ type: 'pause' });
    } else {
      s.phase = PHASE.PLAYING;
      fx.push({ type: 'resume' });
    }
    return;
  }
  if (e.type === 'pause') {
    if (s.phase === PHASE.PLAYING) {
      s.phase = PHASE.PAUSED;
      fx.push({ type: 'pause' });
    }
    return;
  }

  // Everything else needs a live arena. In "ready" the player may try the
  // knob, the polarity and the bolt before starting.
  const live = s.phase === PHASE.PLAYING || s.phase === PHASE.READY;
  if (!live) return;

  switch (e.type) {
    case 'turn':
      if (Number.isFinite(e.detents)) s.shieldTarget += e.detents * CONTROL.DETENT_DEG;
      break;
    case 'flip':
      s.polarity = s.polarity === 1 ? 0 : 1;
      fx.push({ type: 'flip', polarity: s.polarity });
      break;
    case 'tap':
      if (s.cooldown <= 0) {
        s.bolts.push({ id: s.nextId++, a: s.shieldAngle, r: ARENA.SHIELD_R });
        s.cooldown = RULES.BOLT_COOLDOWN_S;
        fx.push({ type: 'fire', a: s.shieldAngle });
      }
      break;
    case 'clap':
      if (s.phase !== PHASE.PLAYING) break;
      if (s.breath >= RULES.SHOCK_COST) {
        s.breath -= RULES.SHOCK_COST;
        s.shocks.push({ id: s.nextId++, r: ARENA.CORE_R });
        fx.push({ type: 'shockwave' });
      } else {
        fx.push({ type: 'shockDenied' });
      }
      break;
    default:
      break;
  }
}

function advance(s, dt, fx) {
  if (s.phase === PHASE.PAUSED) return;

  // The shield glides towards its target so discrete detents feel fluid.
  const follow = 1 - Math.exp(-CONTROL.SHIELD_FOLLOW_PER_S * dt);
  s.shieldAngle += (s.shieldTarget - s.shieldAngle) * follow;
  if (Math.abs(s.shieldTarget - s.shieldAngle) < 0.01) s.shieldAngle = s.shieldTarget;

  if (s.phase === PHASE.OVER) return;

  s.cooldown = Math.max(0, s.cooldown - dt);
  moveBolts(s, dt, fx);
  if (s.phase !== PHASE.PLAYING) return;

  s.time += dt;
  updateBreath(s, dt, fx);
  spawnSparks(s, dt);
  expandShocks(s, dt, fx);
  moveSparks(s, dt, fx);
}

function updateBreath(s, dt, fx) {
  const loud = s.mic >= RULES.BREATH_MIN_LEVEL;
  s.blowing = loud && s.breath > 0;
  if (s.blowing) {
    s.breath -= RULES.BREATH_DRAIN_PER_S * s.mic * dt;
    if (s.breath <= 0) {
      s.breath = 0;
      fx.push({ type: 'breathOut' });
    }
  } else if (!loud) {
    s.breath = Math.min(RULES.BREATH_MAX, s.breath + RULES.BREATH_REFILL_PER_S * dt);
  }
}

function spawnSparks(s, dt) {
  s.spawnIn -= dt;
  while (s.spawnIn <= 0) {
    if (s.sparks.length < RULES.MAX_SPARKS) spawnSpark(s);
    s.spawnIn += spawnInterval(s.time) * (0.8 + 0.4 * rand(s));
  }
}

function spawnSpark(s) {
  const d = difficulty(s.time);
  const d1 = Math.min(d, 1);
  let a;
  let pol;
  if (s.spawned === 0) {
    // The first spark teaches "catch": close to the shield, same polarity.
    a = s.shieldTarget + (rand(s) * 2 - 1) * 40;
    pol = s.polarity;
  } else {
    const wild = rand(s) < RULES.WILD_SPAWN_CHANCE_END * d1;
    const spread = lerp(RULES.SPAWN_SPREAD_START_DEG, RULES.SPAWN_SPREAD_END_DEG, d1);
    a = wild ? rand(s) * 360 : s.lastSpawnAngle + (rand(s) * 2 - 1) * spread;
    const same = rand(s) < lerp(RULES.SAME_POLARITY_START, RULES.SAME_POLARITY_END, d1);
    pol = same ? s.lastSpawnPolarity : 1 - s.lastSpawnPolarity;
  }
  const drift = (rand(s) * 2 - 1) * RULES.DRIFT_MAX_DEG_S * clamp((d - 0.3) / 0.7, 0, 1);
  s.sparks.push({
    id: s.nextId++,
    a: wrapDeg(a),
    r: ARENA.RIM_R,
    pol,
    speed: sparkSpeed(s.time) * (0.88 + 0.24 * rand(s)),
    drift,
  });
  s.spawned += 1;
  s.lastSpawnAngle = a;
  s.lastSpawnPolarity = pol;
}

function addScore(s, points) {
  s.score = Math.min(RULES.SCORE_MAX, s.score + points);
}

function moveBolts(s, dt, fx) {
  if (s.bolts.length === 0) return;
  const halfWidth = boltHalfWidthDeg();
  const reach = 0.03;
  const kept = [];
  for (const b of s.bolts) {
    const from = b.r;
    const to = b.r + RULES.BOLT_SPEED * dt;
    let hit = null;
    for (const sp of s.sparks) {
      if (sp.r < from - reach || sp.r > to + reach) continue;
      if (Math.abs(angleDiff(sp.a, b.a)) > halfWidth) continue;
      if (!hit || sp.r < hit.r) hit = sp;
    }
    if (hit) {
      s.sparks = s.sparks.filter((sp) => sp !== hit);
      s.stats.bolted += 1;
      addScore(s, RULES.BOLT_POINTS);
      fx.push({ type: 'boltKill', a: hit.a, r: hit.r, polarity: hit.pol, points: RULES.BOLT_POINTS });
      continue;
    }
    b.r = to;
    if (b.r < ARENA.RIM_R + 0.05) kept.push(b);
  }
  s.bolts = kept;
}

function expandShocks(s, dt, fx) {
  if (s.shocks.length === 0) return;
  const kept = [];
  for (const shock of s.shocks) {
    shock.r = Math.min(RULES.SHOCK_RADIUS, shock.r + RULES.SHOCK_SPEED * dt);
    const survivors = [];
    for (const sp of s.sparks) {
      if (sp.r <= shock.r) {
        s.stats.shocked += 1;
        addScore(s, RULES.SHOCK_POINTS);
        fx.push({ type: 'shockKill', a: sp.a, r: sp.r, polarity: sp.pol, points: RULES.SHOCK_POINTS });
      } else {
        survivors.push(sp);
      }
    }
    s.sparks = survivors;
    if (shock.r < RULES.SHOCK_RADIUS) kept.push(shock);
  }
  s.shocks = kept;
}

function moveSparks(s, dt, fx) {
  const push = s.blowing ? s.mic * RULES.PUSH_SPEED : 0;
  const arc = ARENA.SHIELD_HALF_ARC_DEG + ARENA.SHIELD_TOLERANCE_DEG;
  const survivors = [];
  let dead = false;

  for (const sp of s.sparks) {
    if (dead) {
      survivors.push(sp);
      continue;
    }
    const before = sp.r;
    const outward = push * (1 - RULES.PUSH_FALLOFF * sp.r);
    sp.r = Math.min(ARENA.RIM_R, sp.r + (outward - sp.speed) * dt);
    sp.a = wrapDeg(sp.a + sp.drift * dt);

    const crossedShield = before > ARENA.SHIELD_R && sp.r <= ARENA.SHIELD_R;
    if (crossedShield && Math.abs(angleDiff(sp.a, s.shieldAngle)) <= arc) {
      if (sp.pol === s.polarity) {
        const mult = multiplier(s.combo);
        const points = RULES.ABSORB_POINTS * mult;
        s.combo += 1;
        s.bestCombo = Math.max(s.bestCombo, s.combo);
        s.stats.absorbed += 1;
        addScore(s, points);
        fx.push({ type: 'absorb', a: sp.a, r: ARENA.SHIELD_R, polarity: sp.pol, points, combo: s.combo, mult });
        continue;
      }
      fx.push({ type: 'pass', a: sp.a, r: ARENA.SHIELD_R, polarity: sp.pol });
    }

    if (sp.r <= ARENA.CORE_R) {
      s.health = Math.max(0, s.health - RULES.CORE_DAMAGE);
      s.combo = 0;
      s.stats.hits += 1;
      fx.push({ type: 'coreHit', a: sp.a, polarity: sp.pol, health: s.health });
      if (s.health <= 0) {
        s.phase = PHASE.OVER;
        s.blowing = false;
        fx.push({ type: 'gameOver', score: s.score });
        dead = true;
      }
      continue;
    }
    survivors.push(sp);
  }
  s.sparks = survivors;
}
