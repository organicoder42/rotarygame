import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARENA, CONTROL, RULES } from '../src/config.js';
import {
  PHASE,
  angleDiff,
  boltHalfWidthDeg,
  createGame,
  multiplier,
  sparkSpeed,
  spawnInterval,
  step,
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
function playing(overrides = {}) {
  const started = step(createGame(42), [{ type: 'hold' }]).state;
  return { ...started, spawnIn: 1e9, ...overrides };
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
    assert.equal(g.breath, 100);
    assert.equal(g.score, 0);
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
    assert.deepEqual(over.effects.at(-1), { type: 'gameOver', score: 730 });

    const again = step(over.state, [{ type: 'hold' }]);
    assert.equal(again.state.phase, PHASE.PLAYING);
    assert.equal(again.state.score, 0);
    assert.equal(again.state.health, 100);
    assert.equal(again.state.sparks.length, 0);
    assert.deepEqual(types(again.effects), ['start']);
  });

  it('nothing moves and no input counts while paused', () => {
    const paused = step(playing({ sparks: [spark(0, 0.6, 1)] }), [{ type: 'hold' }]).state;
    const after = run(paused, 1, [{ type: 'turn', detents: 5 }, { type: 'tap' }, { type: 'flip' }, { type: 'clap' }]);
    assert.equal(after.state.time, paused.time);
    assert.equal(after.state.sparks[0].r, 0.6);
    assert.equal(after.state.shieldTarget, paused.shieldTarget);
    assert.equal(after.state.polarity, paused.polarity);
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
    assert.equal(out.state.shieldTarget, over.shieldTarget);
    assert.deepEqual(out.effects, []);
  });
});

describe('purity', () => {
  it('never mutates the state or the events it is given', () => {
    const state = deepFreeze(
      playing({
        spawnIn: 0,
        sparks: [spark(0, 0.5, 1), spark(0, ARENA.SHIELD_R + 0.001, 1), spark(180, ARENA.CORE_R + 0.001, 0)],
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
    assert.equal(s.shieldTarget, 3 * CONTROL.DETENT_DEG);
    s = step(s, [{ type: 'turn', detents: -5 }]).state;
    assert.equal(s.shieldTarget, -2 * CONTROL.DETENT_DEG);
  });

  it('glides towards the target instead of jumping, and arrives', () => {
    const turned = step(playing(), [{ type: 'turn', detents: 5 }], FRAME).state;
    assert.ok(turned.shieldAngle > 0, 'moves at once');
    assert.ok(turned.shieldAngle < turned.shieldTarget, 'but not all the way');
    const settled = run(turned, 1).state;
    assert.equal(settled.shieldAngle, settled.shieldTarget);
  });

  it('can be tried out before the game starts', () => {
    const s = step(createGame(1), [{ type: 'turn', detents: 2 }]).state;
    assert.equal(s.phase, PHASE.READY);
    assert.equal(s.shieldTarget, 2 * CONTROL.DETENT_DEG);
  });
});

describe('shield and polarity', () => {
  const justOutside = ARENA.SHIELD_R + 0.01;

  it('absorbs a spark of its own polarity: score and combo go up', () => {
    const out = run(playing({ polarity: 1, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.sparks.length, 0);
    assert.equal(out.state.score, RULES.ABSORB_POINTS);
    assert.equal(out.state.combo, 1);
    assert.equal(out.state.health, 100);
    const absorb = out.effects.find((e) => e.type === 'absorb');
    assert.equal(absorb.points, RULES.ABSORB_POINTS);
    assert.equal(absorb.polarity, 1);
  });

  it('lets the other polarity straight through to the core', () => {
    const out = run(playing({ polarity: 1, combo: 6, sparks: [spark(0, justOutside, 0)] }), 1.5);
    assert.deepEqual(types(out.effects), ['pass', 'coreHit']);
    assert.equal(out.state.score, 0);
    assert.equal(out.state.health, 100 - RULES.CORE_DAMAGE);
    assert.equal(out.state.combo, 0, 'a hit on the core breaks the combo');
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
    assert.equal(flipped.state.polarity, 0);
    assert.deepEqual(flipped.effects, [{ type: 'flip', polarity: 0 }]);
    const out = run(flipped.state, 0.3);
    assert.deepEqual(types(out.effects), ['absorb']);
    assert.equal(step(flipped.state, [{ type: 'flip' }]).state.polarity, 1);
  });

  it('pays more for every few absorbs in a row, up to a cap', () => {
    assert.equal(multiplier(0), 1);
    assert.equal(multiplier(RULES.COMBO_PER_MULT - 1), 1);
    assert.equal(multiplier(RULES.COMBO_PER_MULT), 2);
    assert.equal(multiplier(10_000), RULES.MULT_MAX);

    const out = run(playing({ combo: RULES.COMBO_PER_MULT, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.score, RULES.ABSORB_POINTS * 2);
    assert.equal(out.state.combo, RULES.COMBO_PER_MULT + 1);
    assert.equal(out.state.bestCombo, RULES.COMBO_PER_MULT + 1);
  });

  it('caps the score at what the knob can display', () => {
    const out = run(playing({ score: RULES.SCORE_MAX - 3, sparks: [spark(0, justOutside, 1)] }), 0.3);
    assert.equal(out.state.score, RULES.SCORE_MAX);
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
    assert.deepEqual(fired.effects, [{ type: 'fire', a: 90 }]);
    assert.equal(fired.state.bolts.length, 1);

    const out = run(fired.state, 1);
    const kills = out.effects.filter((e) => e.type === 'boltKill');
    assert.equal(kills.length, 1, 'one bolt, one spark');
    assert.equal(kills[0].r, 0.5, 'the nearest one');
    assert.equal(kills[0].polarity, 0, 'even though the shield is the other polarity');
    assert.equal(out.state.score, RULES.BOLT_POINTS);
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
    assert.equal(out.state.score, 0);
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
    assert.equal(blown.blowing, true);
    assert.equal(silent.blowing, false);
  });

  it('pushes harder the louder it is', () => {
    const start = playing({ sparks: [spark(0, 0.5, 0)] });
    const soft = run(start, 0.5, half).state.sparks[0].r;
    const hard = run(start, 0.5, loud).state.sparks[0].r;
    assert.ok(hard > soft);
  });

  it('drains breath in proportion to the loudness', () => {
    const start = playing();
    const lostLoud = 100 - run(start, 1, loud).state.breath;
    const lostHalf = 100 - run(start, 1, half).state.breath;
    assert.ok(Math.abs(lostLoud - RULES.BREATH_DRAIN_PER_S) < 0.5);
    assert.ok(Math.abs(lostLoud - 2 * lostHalf) < 0.5);
  });

  it('ignores noise below the threshold', () => {
    const out = run(playing({ breath: 60 }), 1, [{ type: 'mic', level: RULES.BREATH_MIN_LEVEL / 2 }]).state;
    assert.equal(out.blowing, false);
    assert.ok(out.breath > 60, 'and refills as in silence');
  });

  it('stops pushing when the breath is used up, and says so once', () => {
    const start = playing({ breath: 5, sparks: [spark(0, 0.9, 0)] });
    const out = run(start, 2, loud);
    assert.equal(out.state.breath, 0);
    assert.equal(out.state.blowing, false);
    assert.equal(out.effects.filter((e) => e.type === 'breathOut').length, 1);
    const r = out.state.sparks[0].r;
    assert.ok(run(out.state, 0.5).state.sparks[0].r < r, 'the spark falls inward again');
  });

  it('refills in silence only', () => {
    const empty = playing({ breath: 0 });
    assert.equal(run(empty, 1, loud).state.breath, 0, 'not while it is noisy');
    const refilled = run(empty, 1, quiet).state.breath;
    assert.ok(Math.abs(refilled - RULES.BREATH_REFILL_PER_S) < 0.5);
    assert.equal(run(empty, 60, quiet).state.breath, RULES.BREATH_MAX);
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
    assert.equal(clap.state.breath, 80 - RULES.SHOCK_COST);

    const out = run(clap.state, 1);
    assert.equal(out.effects.filter((e) => e.type === 'shockKill').length, 2);
    assert.deepEqual(out.state.sparks.map((s) => s.id), [far.id]);
    assert.equal(out.state.shocks.length, 0, 'the wave is gone');
    assert.equal(out.state.score, 2 * RULES.SHOCK_POINTS);
  });

  it('works with exactly half the meter and is refused with less', () => {
    const exact = step(playing({ breath: RULES.SHOCK_COST }), [{ type: 'clap' }]);
    assert.deepEqual(types(exact.effects), ['shockwave']);
    assert.equal(exact.state.breath, 0);

    const low = step(playing({ breath: RULES.SHOCK_COST - 1, sparks: [spark(0, 0.3, 0)] }), [{ type: 'clap' }]);
    assert.deepEqual(types(low.effects), ['shockDenied']);
    assert.equal(low.state.breath, RULES.SHOCK_COST - 1);
    assert.equal(low.state.shocks.length, 0);
  });

  it('sanitises the mic level', () => {
    assert.equal(step(playing(), [{ type: 'mic', level: 7 }]).state.mic, 1);
    assert.equal(step(playing(), [{ type: 'mic', level: -1 }]).state.mic, 0);
    assert.equal(step(playing(), [{ type: 'mic', level: NaN }]).state.mic, 0);
  });
});

describe('sparks over time', () => {
  it('holds back during the opening grace period', () => {
    const s = run(step(createGame(3), [{ type: 'hold' }]).state, RULES.START_GRACE_S - 0.1).state;
    assert.equal(s.spawned, 0);
  });

  it('spawns at the rim; the first one matches the shield so it teaches the catch', () => {
    const started = step(createGame(3), [{ type: 'flip' }, { type: 'turn', detents: 4 }, { type: 'hold' }]).state;
    assert.equal(started.polarity, 0);
    const s = run(started, RULES.START_GRACE_S + 0.05).state;
    assert.equal(s.sparks.length, 1);
    assert.equal(s.sparks[0].pol, 0);
    assert.ok(s.sparks[0].r > 0.95);
    assert.ok(Math.abs(angleDiff(s.sparks[0].a, started.shieldTarget)) <= 40);
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
