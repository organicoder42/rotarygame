// Ekko game rules. Pure: no DOM, canvas, timers, serial or Math.random.
//
//   step(state, events, dt) -> { state, effects }
//
// `state` is never mutated; the random generator's seed is part of the state,
// so the same state + events + dt always give the same result.
//
// One or two players share one arena and one core. Each player has their own
// shield (on its own orbit radius), polarity, breath, combo and score. Player 0
// is always there; player 1 joins and leaves through events. With one player
// the game is the single-player game.
//
// Events in. `player` is 0 or 1 and may be left out for player 0:
//   { type: 'join', player }          the player enters the game
//   { type: 'leave', player }         player 1 leaves again
//   { type: 'turn', player, detents } knob moved, clockwise positive
//   { type: 'tap', player }           fire a bolt
//   { type: 'flip', player }          flip the shield's polarity
//   { type: 'hold', player }          start / pause / resume / restart (either player)
//   { type: 'pause' }                 pause if playing (tab hidden, cable pulled)
//   { type: 'mic', player, level }    calibrated loudness 0..1, kept until the next one
//   { type: 'clap', player }          sudden loud peak
//
// Effects out (for haptics, particles and messages). Those that belong to one
// player carry `player`; coreHit and gameOver concern everybody:
//   start, pause, resume, join, leave, flip, fire, pass, absorb, boltKill,
//   shockwave, shockDenied, shockKill, breathOut, coreHit, gameOver

import { ARENA, CONTROL, RULES } from './config.js';

export const PHASE = Object.freeze({
  READY: 'ready',
  PLAYING: 'playing',
  PAUSED: 'paused',
  OVER: 'over',
});

export const MAX_PLAYERS = 2;

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

/** Orbit radius of a player's shield: player 0 inside, player 1 outside. */
export function shieldRadius(player) {
  return ARENA.SHIELD_RADII[player] ?? ARENA.SHIELD_RADII[0];
}

/** Seconds between spawns at a given play time (before random jitter). */
export function spawnInterval(time, players = 1) {
  const d = Math.min(difficulty(time), 1);
  const base = lerp(RULES.SPAWN_INTERVAL_START_S, RULES.SPAWN_INTERVAL_END_S, d);
  return players > 1 ? base * RULES.TWO_PLAYER_INTERVAL_FACTOR : base;
}

/** Inward speed of a spark spawned at a given play time (before jitter). */
export function sparkSpeed(time) {
  return lerp(RULES.SPARK_SPEED_START, RULES.SPARK_SPEED_END, difficulty(time));
}

/** Indexes of the players that are in the game. */
export function joinedPlayers(state) {
  const out = [];
  state.players.forEach((p, i) => {
    if (p.joined) out.push(i);
  });
  return out;
}

/** Sum of all joined players' scores. */
export function teamScore(state) {
  return state.players.reduce((sum, p) => sum + (p.joined ? p.score : 0), 0);
}

/** Index of the joined player with the highest score, or -1 for a tie. */
export function leader(state) {
  const joined = joinedPlayers(state);
  if (joined.length < 2) return joined[0] ?? 0;
  const [a, b] = joined;
  if (state.players[a].score === state.players[b].score) return -1;
  return state.players[a].score > state.players[b].score ? a : b;
}

/** What one player's knob shows: own score, breath and polarity, shared health and phase. */
export function hudValues(state, player) {
  const p = state.players[player] ?? state.players[0];
  return { score: p.score, health: state.health, breath: p.breath, phase: state.phase, polarity: p.polarity };
}

/** Which players should feel an effect: its own player, or everybody. */
export function effectPlayers(effect, state) {
  const joined = joinedPlayers(state);
  if (Number.isInteger(effect.player)) return joined.includes(effect.player) ? [effect.player] : [];
  return joined;
}

function createPlayer(index) {
  return {
    joined: index === 0,
    score: 0,
    breath: RULES.BREATH_MAX,
    combo: 0,
    bestCombo: 0,
    polarity: index === 0 ? 1 : 0,
    shieldTarget: index * 180,
    shieldAngle: index * 180,
    mic: 0,
    blowing: false,
    cooldown: 0,
    stats: { absorbed: 0, bolted: 0, shocked: 0 },
  };
}

/** A fresh single-player game in the "ready" phase. */
export function createGame(seed = 1) {
  const players = Array.from({ length: MAX_PLAYERS }, (_, i) => createPlayer(i));
  return {
    phase: PHASE.READY,
    seed: seed >>> 0,
    time: 0,
    health: RULES.HEALTH_MAX,
    players,
    spawnIn: RULES.START_GRACE_S,
    spawned: 0,
    // One stream of sparks per player, so with two players both get work.
    streams: players.map((p) => ({ angle: p.shieldTarget, polarity: p.polarity, count: 0 })),
    nextId: 1,
    sparks: [],
    bolts: [],
    shocks: [],
    stats: { hits: 0 },
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
    players: p.players.map((x) => ({ ...x, stats: { ...x.stats } })),
    streams: p.streams.map((x) => ({ ...x })),
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
  // The players keep what their hands already set up.
  fresh.players = s.players.map((p, i) => ({
    ...createPlayer(i),
    joined: p.joined,
    polarity: p.polarity,
    shieldTarget: p.shieldTarget,
    shieldAngle: p.shieldAngle,
    mic: p.mic,
  }));
  fresh.streams = fresh.players.map((p) => ({ angle: p.shieldTarget, polarity: p.polarity, count: 0 }));
  fresh.phase = PHASE.PLAYING;
  Object.assign(s, fresh);
}

function join(s, index) {
  const first = s.players[0];
  // The newcomer starts opposite player 0 with the other polarity, so the two
  // shields are told apart at once and cover for each other.
  const target = first.shieldTarget + 180;
  s.players[index] = {
    ...createPlayer(index),
    joined: true,
    polarity: first.polarity === 1 ? 0 : 1,
    shieldTarget: target,
    shieldAngle: target,
  };
  s.streams[index] = { angle: target, polarity: s.players[index].polarity, count: 0 };
}

function applyEvent(s, e, fx) {
  if (!e || typeof e.type !== 'string') return;
  const index = e.player === 1 ? 1 : 0;
  const p = s.players[index];

  if (e.type === 'join') {
    if (!p.joined) {
      join(s, index);
      fx.push({ type: 'join', player: index });
    }
    return;
  }
  if (e.type === 'leave') {
    if (index !== 0 && p.joined) {
      p.joined = false;
      p.blowing = false;
      p.mic = 0;
      s.bolts = s.bolts.filter((b) => b.player !== index);
      fx.push({ type: 'leave', player: index });
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
  // Nothing else counts from somebody who is not in the game.
  if (!p.joined) return;

  if (e.type === 'mic') {
    p.mic = Number.isFinite(e.level) ? clamp(e.level, 0, 1) : 0;
    return;
  }
  if (e.type === 'hold') {
    if (s.phase === PHASE.READY || s.phase === PHASE.OVER) {
      startRun(s);
      fx.push({ type: 'start', player: index });
    } else if (s.phase === PHASE.PLAYING) {
      s.phase = PHASE.PAUSED;
      fx.push({ type: 'pause', player: index });
    } else {
      s.phase = PHASE.PLAYING;
      fx.push({ type: 'resume', player: index });
    }
    return;
  }

  // Everything else needs a live arena. In "ready" the players may try the
  // knob, the polarity and the bolt before starting.
  const live = s.phase === PHASE.PLAYING || s.phase === PHASE.READY;
  if (!live) return;

  switch (e.type) {
    case 'turn':
      if (Number.isFinite(e.detents)) p.shieldTarget += e.detents * CONTROL.DETENT_DEG;
      break;
    case 'flip':
      p.polarity = p.polarity === 1 ? 0 : 1;
      fx.push({ type: 'flip', player: index, polarity: p.polarity });
      break;
    case 'tap':
      if (p.cooldown <= 0) {
        s.bolts.push({ id: s.nextId++, player: index, a: p.shieldAngle, r: shieldRadius(index) });
        p.cooldown = RULES.BOLT_COOLDOWN_S;
        fx.push({ type: 'fire', player: index, a: p.shieldAngle });
      }
      break;
    case 'clap':
      if (s.phase !== PHASE.PLAYING) break;
      // Both microphones hear the same clap: while a wave is still expanding
      // a second one would cost breath and destroy nothing.
      if (s.shocks.length > 0) break;
      if (p.breath >= RULES.SHOCK_COST) {
        p.breath -= RULES.SHOCK_COST;
        s.shocks.push({ id: s.nextId++, player: index, r: ARENA.CORE_R });
        fx.push({ type: 'shockwave', player: index });
      } else {
        fx.push({ type: 'shockDenied', player: index });
      }
      break;
    default:
      break;
  }
}

function advance(s, dt, fx) {
  if (s.phase === PHASE.PAUSED) return;

  // The shields glide towards their targets so discrete detents feel fluid.
  const follow = 1 - Math.exp(-CONTROL.SHIELD_FOLLOW_PER_S * dt);
  for (const p of s.players) {
    if (!p.joined) continue;
    p.shieldAngle += (p.shieldTarget - p.shieldAngle) * follow;
    if (Math.abs(p.shieldTarget - p.shieldAngle) < 0.01) p.shieldAngle = p.shieldTarget;
  }

  if (s.phase === PHASE.OVER) return;

  for (const p of s.players) p.cooldown = Math.max(0, p.cooldown - dt);
  moveBolts(s, dt, fx);
  if (s.phase !== PHASE.PLAYING) return;

  s.time += dt;
  updateBreath(s, dt, fx);
  spawnSparks(s, dt);
  expandShocks(s, dt, fx);
  moveSparks(s, dt, fx);
}

function updateBreath(s, dt, fx) {
  s.players.forEach((p, index) => {
    if (!p.joined) return;
    const loud = p.mic >= RULES.BREATH_MIN_LEVEL;
    p.blowing = loud && p.breath > 0;
    if (p.blowing) {
      p.breath -= RULES.BREATH_DRAIN_PER_S * p.mic * dt;
      if (p.breath <= 0) {
        p.breath = 0;
        fx.push({ type: 'breathOut', player: index });
      }
    } else if (!loud) {
      p.breath = Math.min(RULES.BREATH_MAX, p.breath + RULES.BREATH_REFILL_PER_S * dt);
    }
  });
}

function spawnSparks(s, dt) {
  s.spawnIn -= dt;
  while (s.spawnIn <= 0) {
    const joined = joinedPlayers(s);
    if (s.sparks.length < RULES.MAX_SPARKS) spawnSpark(s, joined[s.spawned % joined.length]);
    s.spawnIn += spawnInterval(s.time, joined.length) * (0.8 + 0.4 * rand(s));
  }
}

function spawnSpark(s, owner) {
  const d = difficulty(s.time);
  const d1 = Math.min(d, 1);
  const stream = s.streams[owner];
  const player = s.players[owner];
  let a;
  let pol;
  if (stream.count === 0) {
    // A stream's first spark teaches "catch": close to that player's shield,
    // same polarity.
    a = player.shieldTarget + (rand(s) * 2 - 1) * 40;
    pol = player.polarity;
  } else {
    const wild = rand(s) < RULES.WILD_SPAWN_CHANCE_END * d1;
    const spread = lerp(RULES.SPAWN_SPREAD_START_DEG, RULES.SPAWN_SPREAD_END_DEG, d1);
    a = wild ? rand(s) * 360 : stream.angle + (rand(s) * 2 - 1) * spread;
    const same = rand(s) < lerp(RULES.SAME_POLARITY_START, RULES.SAME_POLARITY_END, d1);
    pol = same ? stream.polarity : 1 - stream.polarity;
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
  stream.count += 1;
  stream.angle = a;
  stream.polarity = pol;
}

function addScore(player, points) {
  player.score = Math.min(RULES.SCORE_MAX, player.score + points);
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
      const shooter = s.players[b.player];
      s.sparks = s.sparks.filter((sp) => sp !== hit);
      shooter.stats.bolted += 1;
      addScore(shooter, RULES.BOLT_POINTS);
      fx.push({ type: 'boltKill', player: b.player, a: hit.a, r: hit.r, polarity: hit.pol, points: RULES.BOLT_POINTS });
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
    const owner = s.players[shock.player];
    shock.r = Math.min(RULES.SHOCK_RADIUS, shock.r + RULES.SHOCK_SPEED * dt);
    const survivors = [];
    for (const sp of s.sparks) {
      if (sp.r <= shock.r) {
        owner.stats.shocked += 1;
        addScore(owner, RULES.SHOCK_POINTS);
        fx.push({ type: 'shockKill', player: shock.player, a: sp.a, r: sp.r, polarity: sp.pol, points: RULES.SHOCK_POINTS });
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
  // Everybody who blows adds to the push.
  let push = 0;
  for (const p of s.players) if (p.joined && p.blowing) push += p.mic * RULES.PUSH_SPEED;
  const arc = ARENA.SHIELD_HALF_ARC_DEG + ARENA.SHIELD_TOLERANCE_DEG;
  // An incoming spark meets the outermost shield first.
  const shields = joinedPlayers(s).sort((a, b) => shieldRadius(b) - shieldRadius(a));
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

    let absorbed = false;
    for (const index of shields) {
      const radius = shieldRadius(index);
      const p = s.players[index];
      if (!(before > radius && sp.r <= radius)) continue;
      if (Math.abs(angleDiff(sp.a, p.shieldAngle)) > arc) continue;
      if (sp.pol === p.polarity) {
        const mult = multiplier(p.combo);
        const points = RULES.ABSORB_POINTS * mult;
        p.combo += 1;
        p.bestCombo = Math.max(p.bestCombo, p.combo);
        p.stats.absorbed += 1;
        addScore(p, points);
        fx.push({ type: 'absorb', player: index, a: sp.a, r: radius, polarity: sp.pol, points, combo: p.combo, mult });
        absorbed = true;
        break;
      }
      fx.push({ type: 'pass', player: index, a: sp.a, r: radius, polarity: sp.pol });
    }
    if (absorbed) continue;

    if (sp.r <= ARENA.CORE_R) {
      s.health = Math.max(0, s.health - RULES.CORE_DAMAGE);
      // The core is shared: a hit breaks everybody's combo.
      for (const p of s.players) p.combo = 0;
      s.stats.hits += 1;
      fx.push({ type: 'coreHit', a: sp.a, polarity: sp.pol, health: s.health });
      if (s.health <= 0) {
        s.phase = PHASE.OVER;
        for (const p of s.players) p.blowing = false;
        fx.push({ type: 'gameOver', score: teamScore(s), scores: s.players.map((p) => p.score) });
        dead = true;
      }
      continue;
    }
    survivors.push(sp);
  }
  s.sparks = survivors;
}
