import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARENA, CONTROL, RULES } from '../src/config.js';
import {
  PHASE,
  angleDiff,
  boltHalfWidthDeg,
  createGame,
  effectPlayers,
  hudValues,
  joinedPlayers,
  leader,
  multiplier,
  shieldRadius,
  sparkSpeed,
  spawnInterval,
  step,
  teamScore,
  wrapDeg,
} from '../src/game.js';

const FRAME = 1 / 60;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** A running game with spawning switched off, so a test owns every spark. */
const PLAYER_KEYS = new Set([
  'score', 'breath', 'combo', 'bestCombo', 'polarity', 'shieldTarget', 'shieldAngle', 'mic', 'blowing', 'cooldown',
]);

/**
 * A running game with spawning switched off, so a test owns every spark.
 * Per-player keys in `overrides` go to player 0; pass `second` (an object,
 * possibly empty) to have player 1 join with those values.
 */
function playing(overrides = {}, second = null) {
  const events = second ? [{ type: 'join', player: 1 }, { type: 'hold' }] : [{ type: 'hold' }];
  const started = step(createGame(42), events).state;
  const top = {};
  const own = {};
  for (const [key, value] of Object.entries(overrides)) (PLAYER_KEYS.has(key) ? own : top)[key] = value;
  const players = started.players.map((p, i) => (i === 0 ? { ...p, ...own } : second ? { ...p, ...second } : p));
  return { ...started, spawnIn: 1e9, ...top, players };
}

let sparkId = 1000;
function spark(a, r, pol, extra = {}) {
  return { id: sparkId++, a, r, pol, speed: 0.2, drift: 0, ...extra };
}

/** Steps `seconds` of game time in 60 Hz frames, collecting every effect. */
function run(state, seconds, events = []) {
  const effects = [];
  let s = state;
  let first = events;
  for (let i = 0; i < Math.round(seconds / FRAME); i++) {
    const out = step(s, first, FRAME);
    first = [];
    s = out.state;
    effects.push(...out.effects);
  }
  return { state: s, effects };
}

const types = (effects) => effects.map((e) => e.type);

describe('angles', () => {
  it('wraps to [-180, 180)', () => {
    assert.equal(wrapDeg(0), 0);
    assert.equal(wrapDeg(190), -170);
    assert.equal(wrapDeg(-190), 170);
    assert.equal(wrapDeg(720 + 30), 30);
    assert.equal(wrapDeg(180), -180);
  });

  it('measures the shortest signed difference', () => {
    assert.equal(angleDiff(10, 350), 20);
    assert.equal(angleDiff(350, 10), -20);
    assert.equal(angleDiff(-3600 + 5, 0), 5);
  });
});

describe('phases (long press)', () => {
  it('starts in ready with a full core and full breath', () => {
    const g = createGame(1);
    assert.equal(g.phase, PHASE.READY);
    assert.equal(g.health, 100);
    assert.equal(g.players[0].breath, 100);
    assert.equal(g.players[0].score, 0);
  });

  it('ready -> playing -> paused -> playing', () => {
    let out = step(createGame(1), [{ type: 'hold' }]);
    assert.equal(out.state.phase, PHASE.PLAYING);
    assert.deepEqual(types(out.effects), ['start']);

    out = step(out.state, [{ type: 'hold' }]);
    assert.equal(out.state.phase, PHASE.PAUSED);
    assert.deepEqual(types(out.effects), ['pause']);

    out = step(out.state, [{ type: 'hold' }]);
    assert.equal(out.state.phase, PHASE.PLAYING);
    assert.deepEqual(types(out.effects), ['resume']);
  });

  it('game over -> long press restarts with a fresh run', () => {
    const dying = playing({ health: RULES.CORE_DAMAGE, score: 730, sparks: [spark(90, ARENA.CORE_R + 0.01, 0)] });
    const over = run(dying, 0.2);
    assert.equal(over.state.phase, PHASE.OVER);
    assert.equal(over.state.health, 0);
    assert.ok(types(over.effects).includes('coreHit'));
    assert.deepEqual(over.effects.at(-1), { type: 'gameOver', score: 730, scores: [730, 0] });

    const again = step(over.state, [{ type: 'hold' }]);
    assert.equal(again.state.phase, PHASE.PLAYING);
    assert.equal(again.state.players[0].score, 0);
    assert.equal(again.state.health, 100);
    assert.equal(again.state.sparks.length, 0);
    assert.deepEqual(types(again.effects), ['start']);
  });

  it('nothing moves and no input counts while paused', () => {
    const paused = step(playing({ sparks: [spark(0, 0.6, 1)] }), [{ type: 'hold' }]).state;
    const after = run(paused, 1, [{ type: 'turn', detents: 5 }, { type: 'tap' }, { type: 'flip' }, { type: 'clap' }]);
    assert.equal(after.state.time, paused.time);
    assert.equal(after.state.sparks[0].r, 0.6);
    assert.equal(after.state.players[0].shieldTarget, paused.players[0].shieldTarget);
    assert.equal(after.state.players[0].polarity, paused.players[0].polarity);
    assert.equal(after.state.bolts.length, 0);
    assert.deepEqual(after.effects, []);
  });

  it('the pause event pauses only a running game', () => {
    assert.equal(step(createGame(1), [{ type: 'pause' }]).state.phase, PHASE.READY);
    assert.equal(step(playing(), [{ type: 'pause' }]).state.phase, PHASE.PAUSED);
    const paused = step(playing(), [{ type: 'pause' }, { type: 'pause' }]);
    assert.equal(paused.state.phase, PHASE.PAUSED);
    assert.deepEqual(types(paused.effects), ['pause']);
  });

  it('only a long press does anything after game over', () => {
    const over = { ...playing(), phase: PHASE.OVER };
    const out = run(over, 0.5, [{ type: 'turn', detents: 3 }, { type: 'tap' }, { type: 'flip' }, { type: 'clap' }]);
    assert.equal(out.state.phase, PHASE.OVER);
    assert.equal(out.state.players[0].shieldTarget, over.players[0].shieldTarget);
    assert.deepEqual(out.effects, []);
  });
});

describe('purity', () => {
  it('never mutates the state or the events it is given', () => {
    const state = deepFreeze(
      playing({
        spawnIn: 0,
        sparks: [spark(0, 0.5, 1), spark(0, ARENA.SHIELD_RADII[0] + 0.001, 1), spark(180, ARENA.CORE_R + 0.001, 0)],
        mic: 0.8,
      }),
    );
    const events = deepFreeze([{ type: 'turn', detents: 2 }, { type: 'tap' }, { type: 'flip' }, { type: 'clap' }]);
    assert.doesNotThrow(() => step(state, events, FRAME));
  });

  it('is deterministic: same state, events and dt give the same result', () => {
    const a = run(step(createGame(7), [{ type: 'hold' }]).state, 20);
    const b = run(step(createGame(7), [{ type: 'hold' }]).state, 20);
    assert.deepEqual(a.state, b.state);
    assert.ok(a.state.spawned > 5);
    const c = run(step(createGame(8), [{ type: 'hold' }]).state, 20);
    assert.notDeepEqual(a.state.sparks, c.state.sparks);
  });
});

describe('knob = aim', () => {
  it('turns the shield target by a fixed step per detent, in both directions', () => {
    let s = step(playing(), [{ type: 'turn', detents: 3 }]).state;
    assert.equal(s.players[0].shieldTarget, 3 * CONTROL.DETENT_DEG);
    s = step(s, [{ type: 'turn', detents: -5 }]).state;
    assert.equal(s.players[0].shieldTarget, -2 * CONTROL.DETENT_DEG);
  });

  it('glides towards the target instead of jumping, and arrives', () => {
    const turned = step(playing(), [{ type: 'turn', detents: 5 }], FRAME).state;
    assert.ok(turned.players[0].shieldAngle > 0, 'moves at once');
    assert.ok(turned.players[0].shieldAngle < turned.players[0].shieldTarget, 'but not all the way');
    const settled = run(turned, 1).state;
    assert.equal(settled.players[0].shieldAngle, settled.players[0].shieldTarget);
  });

  it('can be tried out before the game starts', () => {
    const s = step(createGame(1), [{ type: 'turn', detents: 2 }]).state;
    assert.equal(s.phase, PHASE.READY);
    assert.equal(s.players[0].shieldTarget, 2 * CONTROL.DETENT_DEG);
  });
});

describe('shield and polarity', () => {
  const justOutside = ARENA.SHIELD_RADII[0] + 0.01;

  it('absorbs a spark of its own polarity: score and combo go up', () => {
    const out = run(playing({ polarity: 1, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.sparks.length, 0);
    assert.equal(out.state.players[0].score, RULES.ABSORB_POINTS);
    assert.equal(out.state.players[0].combo, 1);
    assert.equal(out.state.health, 100);
    const absorb = out.effects.find((e) => e.type === 'absorb');
    assert.equal(absorb.points, RULES.ABSORB_POINTS);
    assert.equal(absorb.polarity, 1);
  });

  it('lets the other polarity straight through to the core', () => {
    const out = run(playing({ polarity: 1, combo: 6, sparks: [spark(0, justOutside, 0)] }), 1.5);
    assert.deepEqual(types(out.effects), ['pass', 'coreHit']);
    assert.equal(out.state.players[0].score, 0);
    assert.equal(out.state.health, 100 - RULES.CORE_DAMAGE);
    assert.equal(out.state.players[0].combo, 0, 'a hit on the core breaks the combo');
    assert.equal(out.state.stats.hits, 1);
  });

  it('does not catch a spark that arrives outside the arc', () => {
    const outside = ARENA.SHIELD_HALF_ARC_DEG + ARENA.SHIELD_TOLERANCE_DEG + 5;
    const out = run(playing({ sparks: [spark(outside, justOutside, 1)] }), 1.5);
    assert.deepEqual(types(out.effects), ['coreHit']);
  });

  it('catches at the edge of the arc and across the 180 degree seam', () => {
    const edge = ARENA.SHIELD_HALF_ARC_DEG - 1;
    const a = run(playing({ sparks: [spark(edge, justOutside, 1)] }), 0.3);
    assert.deepEqual(types(a.effects), ['absorb']);
    const b = run(playing({ shieldTarget: 175, shieldAngle: 175, sparks: [spark(-170, justOutside, 1)] }), 0.3);
    assert.deepEqual(types(b.effects), ['absorb']);
    const c = run(playing({ shieldTarget: 3600 + 90, shieldAngle: 3600 + 90, sparks: [spark(90, justOutside, 1)] }), 0.3);
    assert.deepEqual(types(c.effects), ['absorb'], 'the knob may have turned many revolutions');
  });

  it('a tap on the small circle flips the polarity', () => {
    const flipped = step(playing({ polarity: 1, sparks: [spark(0, justOutside, 0)] }), [{ type: 'flip' }]);
    assert.equal(flipped.state.players[0].polarity, 0);
    assert.deepEqual(flipped.effects, [{ type: 'flip', player: 0, polarity: 0 }]);
    const out = run(flipped.state, 0.3);
    assert.deepEqual(types(out.effects), ['absorb']);
    assert.equal(step(flipped.state, [{ type: 'flip' }]).state.players[0].polarity, 1);
  });

  it('pays more for every few absorbs in a row, up to a cap', () => {
    assert.equal(multiplier(0), 1);
    assert.equal(multiplier(RULES.COMBO_PER_MULT - 1), 1);
    assert.equal(multiplier(RULES.COMBO_PER_MULT), 2);
    assert.equal(multiplier(10_000), RULES.MULT_MAX);

    const out = run(playing({ combo: RULES.COMBO_PER_MULT, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.players[0].score, RULES.ABSORB_POINTS * 2);
    assert.equal(out.state.players[0].combo, RULES.COMBO_PER_MULT + 1);
    assert.equal(out.state.players[0].bestCombo, RULES.COMBO_PER_MULT + 1);
  });

  it('caps the score at what the knob can display', () => {
    const out = run(playing({ score: RULES.SCORE_MAX - 3, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.players[0].score, RULES.SCORE_MAX);
  });
});

describe('tap = bolt', () => {
  it('fires along the shield and destroys the first spark in its path, whatever its polarity', () => {
    const start = playing({
      shieldTarget: 90,
      shieldAngle: 90,
      polarity: 1,
      sparks: [spark(90, 0.8, 1, { speed: 0 }), spark(90, 0.5, 0, { speed: 0 }), spark(270, 0.5, 0, { speed: 0 })],
    });
    const fired = step(start, [{ type: 'tap' }]);
    assert.deepEqual(fired.effects, [{ type: 'fire', player: 0, a: 90 }]);
    assert.equal(fired.state.bolts.length, 1);

    const out = run(fired.state, 1);
    const kills = out.effects.filter((e) => e.type === 'boltKill');
    assert.equal(kills.length, 1, 'one bolt, one spark');
    assert.equal(kills[0].r, 0.5, 'the nearest one');
    assert.equal(kills[0].polarity, 0, 'even though the shield is the other polarity');
    assert.equal(out.state.players[0].score, RULES.BOLT_POINTS);
    assert.equal(out.state.sparks.length, 2);
    assert.equal(out.state.bolts.length, 0, 'the bolt is spent');
  });

  it('has a short cooldown', () => {
    const first = step(playing(), [{ type: 'tap' }, { type: 'tap' }]);
    assert.equal(first.state.bolts.length, 1);
    const tooSoon = step(run(first.state, RULES.BOLT_COOLDOWN_S / 2).state, [{ type: 'tap' }]);
    assert.ok(!types(tooSoon.effects).includes('fire'));
    const later = step(run(first.state, RULES.BOLT_COOLDOWN_S + 0.05).state, [{ type: 'tap' }]);
    assert.ok(types(later.effects).includes('fire'));
  });

  it('misses sparks beside its path and disappears at the rim', () => {
    const beside = boltHalfWidthDeg() + 4;
    const out = run(step(playing({ sparks: [spark(beside, 0.6, 1, { speed: 0 })] }), [{ type: 'tap' }]).state, 1);
    assert.equal(out.state.sparks.length, 1);
    assert.equal(out.state.bolts.length, 0);
    assert.equal(out.state.players[0].score, 0);
  });

  it('can reach a spark at any angle from some knob position', () => {
    assert.ok(boltHalfWidthDeg() >= CONTROL.DETENT_DEG / 2);
    for (let angle = 0; angle < CONTROL.DETENT_DEG; angle += 0.5) {
      const nearestDetent = Math.round(angle / CONTROL.DETENT_DEG) * CONTROL.DETENT_DEG;
      const start = playing({
        shieldTarget: nearestDetent,
        shieldAngle: nearestDetent,
        sparks: [spark(angle, 0.95, 0, { speed: 0 })],
      });
      const out = run(step(start, [{ type: 'tap' }]).state, 0.6);
      assert.equal(out.state.sparks.length, 0, `spark at ${angle} degrees`);
    }
  });

  it('does not tunnel through a spark in one long step', () => {
    const start = step(playing({ sparks: [spark(0, 0.7, 1, { speed: 0 })] }), [{ type: 'tap' }]).state;
    const out = step(start, [], 0.5);
    assert.deepEqual(types(out.effects), ['boltKill']);
  });
});

describe('microphone = breath', () => {
  const quiet = [{ type: 'mic', level: 0 }];
  const loud = [{ type: 'mic', level: 1 }];
  const half = [{ type: 'mic', level: 0.5 }];

  it('pushes sparks outward while there is noise and breath', () => {
    const start = playing({ sparks: [spark(0, 0.5, 0)] });
    const silent = run(start, 0.5, quiet).state;
    const blown = run(start, 0.5, loud).state;
    assert.ok(silent.sparks[0].r < 0.5, 'drifts in when it is quiet');
    assert.ok(blown.sparks[0].r > 0.5, 'is pushed out when it is loud');
    assert.equal(blown.players[0].blowing, true);
    assert.equal(silent.players[0].blowing, false);
  });

  it('pushes harder the louder it is', () => {
    const start = playing({ sparks: [spark(0, 0.5, 0)] });
    const soft = run(start, 0.5, half).state.sparks[0].r;
    const hard = run(start, 0.5, loud).state.sparks[0].r;
    assert.ok(hard > soft);
  });

  it('drains breath in proportion to the loudness', () => {
    const start = playing();
    const lostLoud = 100 - run(start, 1, loud).state.players[0].breath;
    const lostHalf = 100 - run(start, 1, half).state.players[0].breath;
    assert.ok(Math.abs(lostLoud - RULES.BREATH_DRAIN_PER_S) < 0.5);
    assert.ok(Math.abs(lostLoud - 2 * lostHalf) < 0.5);
  });

  it('ignores noise below the threshold', () => {
    const out = run(playing({ breath: 60 }), 1, [{ type: 'mic', level: RULES.BREATH_MIN_LEVEL / 2 }]).state;
    assert.equal(out.players[0].blowing, false);
    assert.ok(out.players[0].breath > 60, 'and refills as in silence');
  });

  it('stops pushing when the breath is used up, and says so once', () => {
    const start = playing({ breath: 5, sparks: [spark(0, 0.9, 0)] });
    const out = run(start, 2, loud);
    assert.equal(out.state.players[0].breath, 0);
    assert.equal(out.state.players[0].blowing, false);
    assert.equal(out.effects.filter((e) => e.type === 'breathOut').length, 1);
    const r = out.state.sparks[0].r;
    assert.ok(run(out.state, 0.5).state.sparks[0].r < r, 'the spark falls inward again');
  });

  it('refills in silence only', () => {
    const empty = playing({ breath: 0 });
    assert.equal(run(empty, 1, loud).state.players[0].breath, 0, 'not while it is noisy');
    const refilled = run(empty, 1, quiet).state.players[0].breath;
    assert.ok(Math.abs(refilled - RULES.BREATH_REFILL_PER_S) < 0.5);
    assert.equal(run(empty, 60, quiet).state.players[0].breath, RULES.BREATH_MAX);
  });

  it('keeps a pushed spark inside the arena', () => {
    const out = run(playing({ sparks: [spark(0, 0.95, 0)] }), 1, loud).state;
    assert.equal(out.sparks.length, 1);
    assert.ok(out.sparks[0].r <= ARENA.RIM_R);
  });

  it('a clap with at least half the meter releases a shockwave that destroys everything nearby', () => {
    const near = [spark(0, 0.3, 0, { speed: 0 }), spark(120, 0.5, 1, { speed: 0 })];
    const far = spark(240, RULES.SHOCK_RADIUS + 0.2, 1, { speed: 0 });
    const clap = step(playing({ breath: 80, sparks: [...near, far] }), [{ type: 'clap' }]);
    assert.deepEqual(types(clap.effects), ['shockwave']);
    assert.equal(clap.state.players[0].breath, 80 - RULES.SHOCK_COST);

    const out = run(clap.state, 1);
    assert.equal(out.effects.filter((e) => e.type === 'shockKill').length, 2);
    assert.deepEqual(out.state.sparks.map((s) => s.id), [far.id]);
    assert.equal(out.state.shocks.length, 0, 'the wave is gone');
    assert.equal(out.state.players[0].score, 2 * RULES.SHOCK_POINTS);
  });

  it('works with exactly half the meter and is refused with less', () => {
    const exact = step(playing({ breath: RULES.SHOCK_COST }), [{ type: 'clap' }]);
    assert.deepEqual(types(exact.effects), ['shockwave']);
    assert.equal(exact.state.players[0].breath, 0);

    const low = step(playing({ breath: RULES.SHOCK_COST - 1, sparks: [spark(0, 0.3, 0)] }), [{ type: 'clap' }]);
    assert.deepEqual(types(low.effects), ['shockDenied']);
    assert.equal(low.state.players[0].breath, RULES.SHOCK_COST - 1);
    assert.equal(low.state.shocks.length, 0);
  });

  it('sanitises the mic level', () => {
    assert.equal(step(playing(), [{ type: 'mic', level: 7 }]).state.players[0].mic, 1);
    assert.equal(step(playing(), [{ type: 'mic', level: -1 }]).state.players[0].mic, 0);
    assert.equal(step(playing(), [{ type: 'mic', level: NaN }]).state.players[0].mic, 0);
  });
});

describe('sparks over time', () => {
  it('holds back during the opening grace period', () => {
    const s = run(step(createGame(3), [{ type: 'hold' }]).state, RULES.START_GRACE_S - 0.1).state;
    assert.equal(s.spawned, 0);
  });

  it('spawns at the rim; the first one matches the shield so it teaches the catch', () => {
    const started = step(createGame(3), [{ type: 'flip' }, { type: 'turn', detents: 4 }, { type: 'hold' }]).state;
    assert.equal(started.players[0].polarity, 0);
    const s = run(started, RULES.START_GRACE_S + 0.05).state;
    assert.equal(s.sparks.length, 1);
    assert.equal(s.sparks[0].pol, 0);
    assert.ok(s.sparks[0].r > 0.95);
    assert.ok(Math.abs(angleDiff(s.sparks[0].a, started.players[0].shieldTarget)) <= 40);
  });

  it('uses both polarities', () => {
    const seen = new Set();
    let g = step(createGame(5), [{ type: 'hold' }]).state;
    for (let i = 0; i < 1200 && g.phase === PHASE.PLAYING; i++) {
      g = step(g, [], FRAME).state;
      for (const sp of g.sparks) seen.add(sp.pol);
    }
    assert.ok(g.spawned >= 8);
    assert.deepEqual([...seen].sort(), [0, 1]);
  });

  it('gets denser and faster as time passes', () => {
    assert.ok(spawnInterval(RULES.RAMP_S) < spawnInterval(0));
    assert.ok(sparkSpeed(RULES.RAMP_S) > sparkSpeed(0));
    assert.ok(spawnInterval(60) < spawnInterval(20));
    assert.ok(sparkSpeed(60) > sparkSpeed(20));
    assert.equal(spawnInterval(1e6), RULES.SPAWN_INTERVAL_END_S);

    const countSpawns = (from) => {
      const base = { ...playing(), spawnIn: 0, time: from, health: 1e9 };
      return run(base, 10).state.spawned;
    };
    assert.ok(countSpawns(90) > countSpawns(0) * 1.8);
  });

  it('never keeps more sparks than the cap', () => {
    const crowded = playing({
      spawnIn: 0,
      time: 500,
      sparks: Array.from({ length: RULES.MAX_SPARKS }, (_, i) => spark(i * 6, 0.9, 1, { speed: 0 })),
    });
    assert.equal(run(crowded, 3).state.sparks.length, RULES.MAX_SPARKS);
  });

  it('an untouched game is lost, not endless', () => {
    const out = run(step(createGame(11), [{ type: 'hold' }]).state, 90);
    assert.equal(out.state.phase, PHASE.OVER);
    assert.equal(out.effects.filter((e) => e.type === 'gameOver').length, 1);
    assert.ok(out.state.time > 10, `lasted ${out.state.time.toFixed(1)} s`);
  });
});

describe('single player is unchanged by the two-player rules', () => {
  it('replays a recorded single-player game to exactly the same result', () => {
    // Recorded from the rules as they were before a second player existed.
    let g = step(createGame(20261117), [{ type: 'hold' }]).state;
    const counts = {};
    for (let i = 0; i < 60 * 45 && g.phase === PHASE.PLAYING; i++) {
      const ev = [];
      if (i % 7 === 0) ev.push({ type: 'turn', detents: (i / 7) % 9 < 5 ? 1 : -1 });
      if (i % 50 === 10) ev.push({ type: 'tap' });
      if (i % 170 === 30) ev.push({ type: 'flip' });
      if (i % 600 === 300) ev.push({ type: 'clap' });
      if (i % 240 === 0) ev.push({ type: 'mic', level: 0.7 });
      if (i % 240 === 40) ev.push({ type: 'mic', level: 0 });
      const out = step(g, ev, FRAME);
      g = out.state;
      for (const e of out.effects) counts[e.type] = (counts[e.type] || 0) + 1;
    }
    const me = g.players[0];
    const sum = g.sparks.reduce((acc, s) => acc + s.a * s.r + s.pol + s.speed, 0);
    assert.deepEqual(
      {
        phase: g.phase,
        time: +g.time.toFixed(4),
        score: me.score,
        health: g.health,
        breath: +me.breath.toFixed(4),
        bestCombo: me.bestCombo,
        spawned: g.spawned,
        sparks: g.sparks.length,
        sum: +sum.toFixed(6),
        shieldTarget: me.shieldTarget,
        polarity: me.polarity,
        stats: { ...me.stats, ...g.stats },
        counts,
      },
      {
        phase: 'over',
        time: 41.9167,
        score: 88,
        health: 0,
        breath: 94.5667,
        bestCombo: 1,
        spawned: 33,
        sparks: 3,
        sum: 111.341078,
        shieldTarget: 480,
        polarity: 0,
        stats: { absorbed: 2, bolted: 10, shocked: 9, hits: 9 },
        counts: { fire: 51, flip: 15, shockwave: 4, shockKill: 9, coreHit: 9, pass: 1, boltKill: 10, absorb: 2, gameOver: 1 },
      },
    );
  });

  it('player 2 does not exist until they join: their events do nothing', () => {
    const start = playing({ sparks: [spark(180, 0.6, 0, { speed: 0 })] });
    const events = ['turn', 'tap', 'flip', 'hold', 'clap', 'mic'].map((type) => ({ type, player: 1, detents: 3, level: 1 }));
    const out = run(start, 0.5, events);
    assert.deepEqual(out.effects, []);
    assert.equal(out.state.phase, PHASE.PLAYING);
    assert.deepEqual(joinedPlayers(out.state), [0]);
    assert.deepEqual(out.state.players[1], start.players[1]);
    assert.equal(out.state.sparks.length, 1);
  });
});

describe('two players: joining', () => {
  it('player 2 joins opposite player 1, with the other polarity, on the outer orbit', () => {
    const before = step(createGame(1), [{ type: 'turn', detents: 5 }]).state;
    const out = step(before, [{ type: 'join', player: 1 }]);
    assert.deepEqual(out.effects, [{ type: 'join', player: 1 }]);
    assert.deepEqual(joinedPlayers(out.state), [0, 1]);
    const [a, b] = out.state.players;
    assert.equal(Math.abs(angleDiff(b.shieldTarget, a.shieldTarget)), 180);
    assert.equal(b.shieldAngle, b.shieldTarget);
    assert.notEqual(b.polarity, a.polarity);
    assert.ok(shieldRadius(1) > shieldRadius(0) + 0.05, 'room for the shields to pass each other');
    assert.ok(shieldRadius(1) < RULES.SHOCK_RADIUS);
  });

  it('joining twice changes nothing, and player 1 can neither join again nor leave', () => {
    const joined = step(createGame(1), [{ type: 'join', player: 1 }, { type: 'turn', player: 1, detents: 2 }]).state;
    const again = step(joined, [{ type: 'join', player: 1 }, { type: 'join', player: 0 }, { type: 'leave', player: 0 }]);
    assert.deepEqual(again.effects, []);
    assert.deepEqual(again.state.players, joined.players);
  });

  it('can join in the middle of a run without disturbing player 1', () => {
    const mid = run(playing({ score: 120, combo: 3, breath: 40 }), 0.2).state;
    const out = step(mid, [{ type: 'join', player: 1 }]);
    assert.equal(out.state.phase, PHASE.PLAYING);
    assert.equal(out.state.players[0].score, 120);
    assert.equal(out.state.players[0].combo, 3);
    assert.equal(out.state.players[1].score, 0);
    assert.equal(out.state.players[1].breath, RULES.BREATH_MAX);
  });

  it('leaving takes the shield and bolts away and makes it a single-player game again', () => {
    const two = step(playing({}, {}), [{ type: 'tap', player: 1 }, { type: 'tap', player: 0 }]).state;
    assert.equal(two.bolts.length, 2);
    const out = step(two, [{ type: 'leave', player: 1 }]);
    assert.deepEqual(out.effects, [{ type: 'leave', player: 1 }]);
    assert.deepEqual(joinedPlayers(out.state), [0]);
    assert.deepEqual(out.state.bolts.map((b) => b.player), [0]);
    assert.deepEqual(types(step(out.state, [{ type: 'flip', player: 1 }]).effects), []);
  });

  it('a new run keeps who is playing, their shields and polarities, and resets both scores', () => {
    const two = playing({ score: 50, health: RULES.CORE_DAMAGE, sparks: [spark(90, ARENA.CORE_R + 0.01, 0)] }, { score: 70, shieldTarget: 222, shieldAngle: 222, polarity: 1 });
    const over = run(two, 0.2).state;
    assert.equal(over.phase, PHASE.OVER);
    const again = step(over, [{ type: 'hold', player: 1 }]).state;
    assert.equal(again.phase, PHASE.PLAYING);
    assert.deepEqual(joinedPlayers(again), [0, 1]);
    assert.deepEqual(again.players.map((p) => p.score), [0, 0]);
    assert.equal(again.players[1].shieldTarget, 222);
    assert.equal(again.players[1].polarity, 1);
    assert.equal(again.health, RULES.HEALTH_MAX);
  });
});

describe('two players: each has their own controls', () => {
  it('each knob turns only its own shield', () => {
    const start = playing({ shieldTarget: 0 }, { shieldTarget: 180 });
    const s = step(start, [{ type: 'turn', player: 1, detents: 3 }, { type: 'turn', player: 0, detents: -1 }]).state;
    assert.equal(s.players[0].shieldTarget, -CONTROL.DETENT_DEG);
    assert.equal(s.players[1].shieldTarget, 180 + 3 * CONTROL.DETENT_DEG);
    const settled = run(s, 1).state;
    assert.equal(settled.players[1].shieldAngle, settled.players[1].shieldTarget);
  });

  it('each circle tap flips only its own polarity', () => {
    const start = playing({ polarity: 1 }, { polarity: 0 });
    const out = step(start, [{ type: 'flip', player: 1 }]);
    assert.deepEqual(out.state.players.map((p) => p.polarity), [1, 1]);
    assert.deepEqual(out.effects, [{ type: 'flip', player: 1, polarity: 1 }]);
  });

  it('a long press from either player starts, pauses and resumes', () => {
    const ready = step(createGame(1), [{ type: 'join', player: 1 }]).state;
    const started = step(ready, [{ type: 'hold', player: 1 }]);
    assert.equal(started.state.phase, PHASE.PLAYING);
    assert.deepEqual(types(started.effects), ['start']);
    const paused = step(started.state, [{ type: 'hold', player: 0 }]).state;
    assert.equal(paused.phase, PHASE.PAUSED);
    assert.equal(step(paused, [{ type: 'hold', player: 1 }]).state.phase, PHASE.PLAYING);
  });

  it('each bolt flies from its own shield, has its own cooldown and scores for its shooter', () => {
    const start = playing(
      { shieldTarget: 0, shieldAngle: 0, sparks: [spark(0, 0.7, 0, { speed: 0 }), spark(170, 0.7, 1, { speed: 0 })] },
      { shieldTarget: 170, shieldAngle: 170 },
    );
    const fired = step(start, [{ type: 'tap', player: 0 }, { type: 'tap', player: 1 }, { type: 'tap', player: 1 }]);
    assert.deepEqual(fired.effects, [
      { type: 'fire', player: 0, a: 0 },
      { type: 'fire', player: 1, a: 170 },
    ]);
    assert.deepEqual(fired.state.bolts.map((b) => [b.player, b.r]), [[0, shieldRadius(0)], [1, shieldRadius(1)]]);
    const out = run(fired.state, 0.5);
    assert.deepEqual(out.effects.filter((e) => e.type === 'boltKill').map((e) => [e.player, e.a]).sort(), [[0, 0], [1, 170]]);
    assert.deepEqual(out.state.players.map((p) => p.score), [RULES.BOLT_POINTS, RULES.BOLT_POINTS]);
    assert.deepEqual(out.state.players.map((p) => p.stats.bolted), [1, 1]);
  });
});

describe('two players: shields, scores and the shared core', () => {
  const outside = (index) => shieldRadius(index) + 0.01;

  it('each shield absorbs on its own orbit and scores for its own player', () => {
    const start = playing(
      { shieldTarget: 0, shieldAngle: 0, polarity: 1, sparks: [spark(0, outside(0), 1), spark(180, outside(1), 0)] },
      { shieldTarget: 180, shieldAngle: 180, polarity: 0 },
    );
    const out = run(start, 0.3);
    const absorbs = out.effects.filter((e) => e.type === 'absorb');
    assert.deepEqual(absorbs.map((e) => [e.player, e.r]).sort(), [[0, shieldRadius(0)], [1, shieldRadius(1)]]);
    assert.deepEqual(out.state.players.map((p) => p.score), [RULES.ABSORB_POINTS, RULES.ABSORB_POINTS]);
    assert.deepEqual(out.state.players.map((p) => p.combo), [1, 1]);
    assert.equal(out.state.sparks.length, 0);
  });

  it('shields at the same angle: the outer one is met first', () => {
    const same = playing({ shieldTarget: 0, shieldAngle: 0, polarity: 1, sparks: [spark(0, outside(1), 1)] }, { shieldTarget: 0, shieldAngle: 0, polarity: 1 });
    const out = run(same, 1);
    assert.deepEqual(out.effects.filter((e) => e.type === 'absorb').map((e) => e.player), [1]);
    assert.deepEqual(out.state.players.map((p) => p.score), [0, RULES.ABSORB_POINTS]);
  });

  it('what passes the outer shield can still be caught by the inner one', () => {
    const cover = playing({ shieldTarget: 0, shieldAngle: 0, polarity: 1, sparks: [spark(0, outside(1), 1)] }, { shieldTarget: 0, shieldAngle: 0, polarity: 0 });
    const out = run(cover, 1);
    assert.deepEqual(out.effects.map((e) => [e.type, e.player]), [['pass', 1], ['absorb', 0]]);
    assert.equal(out.state.health, RULES.HEALTH_MAX);
    assert.deepEqual(out.state.players.map((p) => p.score), [RULES.ABSORB_POINTS, 0]);
  });

  it('combos and multipliers are per player', () => {
    const start = playing(
      { shieldTarget: 0, shieldAngle: 0, polarity: 1, combo: RULES.COMBO_PER_MULT, sparks: [spark(0, outside(0), 1), spark(180, outside(1), 0)] },
      { shieldTarget: 180, shieldAngle: 180, polarity: 0, combo: 0 },
    );
    const out = run(start, 0.3).state;
    assert.deepEqual(out.players.map((p) => p.score), [2 * RULES.ABSORB_POINTS, RULES.ABSORB_POINTS]);
  });

  it('the core is shared: a hit costs the one health bar and breaks both combos', () => {
    const start = playing({ combo: 5, sparks: [spark(90, ARENA.CORE_R + 0.01, 0)] }, { combo: 7 });
    const out = run(start, 0.2);
    const hit = out.effects.find((e) => e.type === 'coreHit');
    assert.equal(hit.player, undefined, 'belongs to nobody in particular');
    assert.equal(out.state.health, RULES.HEALTH_MAX - RULES.CORE_DAMAGE);
    assert.deepEqual(out.state.players.map((p) => p.combo), [0, 0]);
    assert.equal(out.state.stats.hits, 1);
  });

  it('game over reports both scores, the team total and who scored most', () => {
    const dying = playing({ score: 120, health: 1, sparks: [spark(90, ARENA.CORE_R + 0.01, 0)] }, { score: 300 });
    const out = run(dying, 0.2);
    assert.deepEqual(out.effects.at(-1), { type: 'gameOver', score: 420, scores: [120, 300] });
    assert.equal(teamScore(out.state), 420);
    assert.equal(leader(out.state), 1);
    assert.equal(leader(playing({ score: 10 }, { score: 10 })), -1, 'a tie has no leader');
    assert.equal(leader(playing({ score: 10 }, { score: 3 })), 0);
    assert.equal(leader(playing({ score: 10 })), 0);
    assert.equal(teamScore(playing({ score: 10 })), 10);
  });
});

describe('two players: breath and shockwaves', () => {
  it('each microphone drains only its own breath meter', () => {
    const out = run(playing({}, {}), 1, [{ type: 'mic', player: 1, level: 1 }]).state;
    assert.equal(out.players[0].breath, RULES.BREATH_MAX);
    assert.ok(Math.abs(RULES.BREATH_MAX - out.players[1].breath - RULES.BREATH_DRAIN_PER_S) < 0.5);
    assert.deepEqual(out.players.map((p) => p.blowing), [false, true]);
  });

  it('either player can push the sparks, and together they push harder', () => {
    const start = playing({ sparks: [spark(90, 0.5, 0)] }, {});
    const r = (events) => run(start, 0.4, events).state.sparks[0].r;
    const nobody = r([]);
    const second = r([{ type: 'mic', player: 1, level: 1 }]);
    const both = r([{ type: 'mic', player: 0, level: 1 }, { type: 'mic', player: 1, level: 1 }]);
    assert.ok(nobody < 0.5);
    assert.ok(second > 0.5);
    assert.ok(both > second);
  });

  it('a player out of breath no longer pushes, the other still does', () => {
    const start = playing({ breath: 0, sparks: [spark(90, 0.5, 0)] }, {});
    const loud = [{ type: 'mic', player: 0, level: 1 }, { type: 'mic', player: 1, level: 1 }];
    const out = run(start, 0.4, loud).state;
    assert.deepEqual(out.players.map((p) => p.blowing), [false, true]);
    const alone = run(playing({ sparks: [spark(90, 0.5, 0)] }, {}), 0.4, [{ type: 'mic', player: 1, level: 1 }]).state;
    assert.equal(out.sparks[0].r, alone.sparks[0].r);
  });

  it('a clap spends the clapper\'s own breath and the kills are theirs', () => {
    const start = playing({ breath: 100, sparks: [spark(0, 0.4, 0, { speed: 0 }), spark(90, 0.5, 1, { speed: 0 })] }, { breath: 80 });
    const clap = step(start, [{ type: 'clap', player: 1 }]);
    assert.deepEqual(clap.effects, [{ type: 'shockwave', player: 1 }]);
    assert.deepEqual(clap.state.players.map((p) => p.breath), [100, 80 - RULES.SHOCK_COST]);
    const out = run(clap.state, 1);
    assert.deepEqual(out.effects.filter((e) => e.type === 'shockKill').map((e) => e.player), [1, 1]);
    assert.deepEqual(out.state.players.map((p) => p.score), [0, 2 * RULES.SHOCK_POINTS]);
  });

  it('one clap heard by both microphones is one shockwave, paid for once', () => {
    const start = playing({ breath: 100 }, { breath: 100 });
    const out = step(start, [{ type: 'clap', player: 0 }, { type: 'clap', player: 1 }]);
    assert.deepEqual(out.effects, [{ type: 'shockwave', player: 0 }]);
    assert.equal(out.state.shocks.length, 1);
    assert.deepEqual(out.state.players.map((p) => p.breath), [100 - RULES.SHOCK_COST, 100]);
    // The echo may also arrive a frame or two later, while the wave still expands.
    const later = step(step(out.state, [], FRAME).state, [{ type: 'clap', player: 1 }]);
    assert.deepEqual(later.effects, []);
    assert.equal(later.state.players[1].breath, 100);
    // Once the wave is gone the other player can release their own.
    const gone = run(out.state, 0.6).state;
    assert.deepEqual(types(step(gone, [{ type: 'clap', player: 1 }]).effects), ['shockwave']);
  });

  it('if the first clapper lacks breath, the other one\'s microphone still triggers it', () => {
    const out = step(playing({ breath: 10 }, { breath: 100 }), [{ type: 'clap', player: 0 }, { type: 'clap', player: 1 }]);
    assert.deepEqual(out.effects, [{ type: 'shockDenied', player: 0 }, { type: 'shockwave', player: 1 }]);
  });
});

describe('two players: more sparks, for both', () => {
  it('sparks come more often with two players', () => {
    assert.ok(RULES.TWO_PLAYER_INTERVAL_FACTOR < 1);
    assert.equal(spawnInterval(30, 1), spawnInterval(30));
    assert.ok(Math.abs(spawnInterval(30, 2) - spawnInterval(30) * RULES.TWO_PLAYER_INTERVAL_FACTOR) < 1e-12);
    const spawnedIn10s = (second) => run({ ...playing({}, second), spawnIn: 0, time: 30, health: 1e9 }, 10).state.spawned;
    assert.ok(spawnedIn10s({}) > spawnedIn10s(null) * 1.4);
  });

  it('each player gets a first spark near their own shield in their own polarity', () => {
    const start = { ...playing({ shieldTarget: 0, shieldAngle: 0, polarity: 1 }, { shieldTarget: 180, shieldAngle: 180, polarity: 0 }), spawnIn: 0 };
    let g = start;
    while (g.spawned < 2) g = step(g, [], FRAME).state;
    const [first, second] = g.sparks;
    assert.ok(Math.abs(angleDiff(first.a, 0)) <= 40);
    assert.equal(first.pol, 1);
    assert.ok(Math.abs(angleDiff(second.a, 180)) <= 40);
    assert.equal(second.pol, 0);
  });

  it('the sparks keep alternating between the two players\' sides early on', () => {
    let g = { ...playing({ shieldTarget: 0, shieldAngle: 0 }, { shieldTarget: 180, shieldAngle: 180 }), spawnIn: 0, health: 1e9 };
    const seen = new Map();
    for (let i = 0; i < 60 * 12; i++) {
      g = step(g, [], FRAME).state;
      for (const sp of g.sparks) if (!seen.has(sp.id)) seen.set(sp.id, sp.a);
    }
    const sides = [...seen.values()].map((a) => (Math.abs(angleDiff(a, 0)) < 90 ? 'top' : 'bottom'));
    assert.ok(sides.filter((s) => s === 'top').length >= 3, sides.join(','));
    assert.ok(sides.filter((s) => s === 'bottom').length >= 3, sides.join(','));
  });

  it('an untouched two-player game is also lost, and sooner', () => {
    const two = run(step(createGame(11), [{ type: 'join', player: 1 }, { type: 'hold' }]).state, 90).state;
    const one = run(step(createGame(11), [{ type: 'hold' }]).state, 90).state;
    assert.equal(two.phase, PHASE.OVER);
    assert.ok(two.time < one.time);
  });
});

describe('per-device feedback', () => {
  it('each knob shows its own score, breath and polarity and the shared health and phase', () => {
    const s = playing({ score: 120, breath: 40, polarity: 1, health: 64 }, { score: 300, breath: 90, polarity: 0 });
    assert.deepEqual(hudValues(s, 0), { score: 120, health: 64, breath: 40, phase: 'playing', polarity: 1 });
    assert.deepEqual(hudValues(s, 1), { score: 300, health: 64, breath: 90, phase: 'playing', polarity: 0 });
  });

  it('haptics go to the player they concern; a core hit and game over go to both', () => {
    const two = playing({}, {});
    assert.deepEqual(effectPlayers({ type: 'absorb', player: 1 }, two), [1]);
    assert.deepEqual(effectPlayers({ type: 'boltKill', player: 0 }, two), [0]);
    assert.deepEqual(effectPlayers({ type: 'shockwave', player: 1 }, two), [1]);
    assert.deepEqual(effectPlayers({ type: 'coreHit' }, two), [0, 1]);
    assert.deepEqual(effectPlayers({ type: 'gameOver', score: 5, scores: [2, 3] }, two), [0, 1]);
    const one = playing();
    assert.deepEqual(effectPlayers({ type: 'coreHit' }, one), [0]);
    assert.deepEqual(effectPlayers({ type: 'absorb', player: 1 }, one), [], 'nobody there to feel it');
  });

  it('the effects of a real two-player step carry the right player', () => {
    const start = playing(
      { shieldTarget: 0, shieldAngle: 0, polarity: 1, sparks: [spark(180, shieldRadius(1) + 0.01, 0), spark(90, ARENA.CORE_R + 0.01, 0)] },
      { shieldTarget: 180, shieldAngle: 180, polarity: 0 },
    );
    const out = run(start, 0.2);
    const targets = Object.fromEntries(out.effects.map((e) => [e.type, effectPlayers(e, out.state)]));
    assert.deepEqual(targets, { absorb: [1], coreHit: [0, 1] });
  });
});
