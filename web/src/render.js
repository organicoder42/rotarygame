// Canvas renderer: draws a game state and owns everything that is only
// decoration (particles, rings, floating numbers, screen shake). No rules here.

import { ARENA, CONTROL, RULES } from './config.js';
import { PHASE, joinedPlayers, shieldRadius } from './game.js';

/** The knob's own palette. */
export const PALETTE = Object.freeze({
  bg: '#052D23',
  teal: '#008945',
  amber: '#E8A93C',
  red: '#C0392B',
  lime: '#DAFDA3',
  ink: '#F3EFEF',
});

// Polarity 1 = amber, filled (the knob's small circle is filled);
// polarity 0 = lime, hollow (outline only). Colour and shape both differ.
const POLARITY_COLOR = [PALETTE.lime, PALETTE.amber];

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const MAX_PARTICLES = 700;
/** How long a shield pulses when its player joins or first turns the knob. */
const JOIN_PULSE_S = 2.6;

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Colour of the health ring: idle, caution, alarm (as on the knob). */
export function healthColor(health) {
  if (health > 60) return PALETTE.teal;
  if (health > 30) return PALETTE.amber;
  return PALETTE.red;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cx = 0;
  let cy = 0;
  let R = 100;
  let background = null;

  const particles = [];
  const rings = [];
  const floats = [];
  let clock = 0;
  let ringClock = 0;
  let micShown = 0;
  let shake = 0;
  let flash = 0;
  let coreFlash = 0;
  // Per player.
  const shieldFlash = [0, 0];
  const breathFlash = [0, 0];
  const joinPulse = [0, 0];
  const awaitingTurn = [false, false];
  const lastTarget = [null, null];

  /** Unit arena coordinates (x right, y down, centre 0,0) of a polar point. */
  const ux = (a, r) => Math.sin(a * DEG) * r;
  const uy = (a, r) => -Math.cos(a * DEG) * r;
  const px = (a, r) => cx + ux(a, r) * R;
  const py = (a, r) => cy + uy(a, r) * R;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(320, window.innerWidth);
    height = Math.max(240, window.innerHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // Leave room for the side panels on wide windows.
    const side = width >= 1100 ? 300 : width >= 800 ? 250 : 12;
    R = Math.max(90, Math.min(height * 0.43, width * 0.5 - side));
    cx = width / 2;
    cy = height / 2;
    background = paintBackground();
  }

  function paintBackground() {
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const g = layer.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = PALETTE.bg;
    g.fillRect(0, 0, width, height);

    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
    glow.addColorStop(0, rgba(PALETTE.teal, 0.3));
    glow.addColorStop(0.55, rgba(PALETTE.teal, 0.1));
    glow.addColorStop(1, rgba(PALETTE.teal, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, width, height);

    const far = Math.hypot(width, height) / 2;
    const vignette = g.createRadialGradient(cx, cy, R, cx, cy, far);
    vignette.addColorStop(0, 'rgba(2,18,14,0)');
    vignette.addColorStop(1, 'rgba(2,18,14,0.75)');
    g.fillStyle = vignette;
    g.fillRect(0, 0, width, height);

    // Dust: deterministic, so a resize does not reshuffle it.
    let seed = 7;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 90; i++) {
      const a = next() * 360;
      const r = Math.sqrt(next()) * 0.98;
      g.fillStyle = rgba(PALETTE.lime, 0.05 + next() * 0.12);
      g.beginPath();
      g.arc(px(a, r), py(a, r), 0.6 + next() * 1.2, 0, TAU);
      g.fill();
    }

    for (const [r, alpha, w] of [[0.33, 0.1, 1], [0.55, 0.12, 1], [0.78, 0.14, 1], [1, 0.75, 2]]) {
      g.strokeStyle = rgba(PALETTE.teal, alpha);
      g.lineWidth = w;
      g.beginPath();
      g.arc(cx, cy, R * r, 0, TAU);
      g.stroke();
    }

    // One tick per knob detent around the rim.
    const ticks = Math.max(4, Math.round(360 / CONTROL.DETENT_DEG));
    g.strokeStyle = rgba(PALETTE.teal, 0.8);
    g.lineWidth = 1.5;
    for (let i = 0; i < ticks; i++) {
      const a = (i * 360) / ticks;
      g.beginPath();
      g.moveTo(px(a, 1.0), py(a, 1.0));
      g.lineTo(px(a, i % 5 === 0 ? 0.965 : 0.98), py(a, i % 5 === 0 ? 0.965 : 0.98));
      g.stroke();
    }
    return layer;
  }

  function burst(a, r, color, count, speed) {
    const x = ux(a, r);
    const y = uy(a, r);
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const dir = Math.random() * TAU;
      const v = speed * (0.25 + Math.random() * 0.75);
      const life = 0.35 + Math.random() * 0.5;
      particles.push({ x, y, vx: Math.cos(dir) * v, vy: Math.sin(dir) * v, life, max: life, color, size: 0.006 + Math.random() * 0.008 });
    }
  }

  function floatText(text, a, r, color) {
    floats.push({ text, a, r, color, life: 0.9, max: 0.9 });
  }

  /** Feed the effects returned by the rules so they become visible. */
  function addEffects(effects) {
    for (const e of effects) {
      switch (e.type) {
        case 'absorb':
          burst(e.a, e.r, POLARITY_COLOR[e.polarity], 12, 0.45);
          floatText(`+${e.points}`, e.a, e.r + 0.07, POLARITY_COLOR[e.polarity]);
          shieldFlash[e.player ?? 0] = 1;
          break;
        case 'boltKill':
          burst(e.a, e.r, PALETTE.ink, 10, 0.7);
          burst(e.a, e.r, POLARITY_COLOR[e.polarity], 8, 0.4);
          floatText(`+${e.points}`, e.a, e.r, PALETTE.ink);
          break;
        case 'shockKill':
          burst(e.a, e.r, POLARITY_COLOR[e.polarity], 9, 0.6);
          break;
        case 'pass':
          burst(e.a, e.r, PALETTE.ink, 4, 0.25);
          break;
        case 'fire':
          burst(e.a, shieldRadius(e.player ?? 0) + 0.03, PALETTE.ink, 4, 0.3);
          break;
        case 'flip':
          shieldFlash[e.player ?? 0] = 0.7;
          break;
        case 'join':
          // The newcomer's shield pulses now; everybody's pulses again the
          // first time they turn their knob, so each finds their own.
          joinPulse[e.player] = JOIN_PULSE_S;
          awaitingTurn.fill(true);
          break;
        case 'leave':
          joinPulse.fill(0);
          awaitingTurn.fill(false);
          break;
        case 'coreHit':
          burst(e.a, ARENA.CORE_R, PALETTE.red, 24, 0.8);
          shake = Math.max(shake, R * 0.028);
          coreFlash = 1;
          break;
        case 'shockwave':
          shake = Math.max(shake, R * 0.022);
          flash = Math.max(flash, 0.2);
          break;
        case 'shockDenied':
        case 'breathOut':
          breathFlash[e.player ?? 0] = 1;
          break;
        case 'gameOver':
          for (let i = 0; i < 10; i++) burst(i * 36, ARENA.CORE_R, i % 2 ? PALETTE.red : PALETTE.amber, 12, 1.3);
          shake = Math.max(shake, R * 0.06);
          flash = Math.max(flash, 0.35);
          break;
        default:
          break;
      }
    }
  }

  function arc(r, fromDeg, toDeg) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * r, (fromDeg - 90) * DEG, (toDeg - 90) * DEG);
    ctx.stroke();
  }

  function drawHealthRim(state) {
    const r = 1.05;
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(3, R * 0.014);
    ctx.strokeStyle = rgba(PALETTE.ink, 0.08);
    arc(r, 0, 360);
    const share = state.health / RULES.HEALTH_MAX;
    if (share <= 0) return;
    const color = healthColor(state.health);
    const pulse = state.health <= 30 ? 0.65 + 0.35 * Math.sin(clock * 9) : 1;
    ctx.strokeStyle = rgba(color, pulse);
    ctx.shadowColor = color;
    ctx.shadowBlur = R * 0.03;
    ctx.lineCap = 'round';
    arc(r, 0, Math.max(1, 360 * share));
    ctx.shadowBlur = 0;
  }

  // The microphone is always visible: rings leave the core faster, brighter
  // and more often the louder the room is, even when the game is not running.
  function drawMicRings(state, level, dt) {
    micShown += (level - micShown) * (1 - Math.exp(-dt * 16));
    ringClock += dt * (1.3 + micShown * 11);
    while (ringClock >= 1) {
      ringClock -= 1;
      if (rings.length < 40) {
        rings.push({ r: ARENA.CORE_R, speed: 0.22 + micShown * 0.95, alpha: 0.16 + micShown * 0.6, strong: state.players.some((p) => p.joined && p.blowing) });
      }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.r += ring.speed * dt;
      if (ring.r >= 1) {
        rings.splice(i, 1);
        continue;
      }
      const fade = 1 - ring.r;
      ctx.strokeStyle = rgba(ring.strong ? PALETTE.lime : PALETTE.ink, ring.alpha * fade);
      ctx.lineWidth = ring.strong ? Math.max(1.5, R * 0.007) : 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * ring.r, 0, TAU);
      ctx.stroke();
    }
  }

  function drawShocks(state) {
    for (const shock of state.shocks) {
      const t = shock.r / RULES.SHOCK_RADIUS;
      ctx.strokeStyle = rgba(PALETTE.ink, 1 - 0.6 * t * t);
      ctx.shadowColor = PALETTE.lime;
      ctx.shadowBlur = R * 0.06;
      ctx.lineWidth = Math.max(2, R * 0.03 * (1 - 0.6 * t));
      ctx.beginPath();
      ctx.arc(cx, cy, R * shock.r, 0, TAU);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function drawAim(state, index) {
    if (state.phase !== PHASE.PLAYING && state.phase !== PHASE.READY) return;
    const player = state.players[index];
    const a = player.shieldAngle;
    const from = shieldRadius(index) + 0.04;
    ctx.strokeStyle = rgba(PALETTE.ink, player.cooldown > 0 ? 0.05 : 0.14);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([R * 0.012, R * 0.028]);
    ctx.beginPath();
    ctx.moveTo(px(a, from), py(a, from));
    ctx.lineTo(px(a, 0.97), py(a, 0.97));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawPolarityShape(x, y, size, polarity, spin) {
    const color = POLARITY_COLOR[polarity];
    if (polarity === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    } else {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 4 + spin);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, size * 0.42);
      ctx.lineJoin = 'miter';
      ctx.strokeRect(-size * 0.85, -size * 0.85, size * 1.7, size * 1.7);
      ctx.restore();
    }
  }

  function drawSparks(state) {
    const size = Math.max(5, R * 0.025);
    for (const sp of state.sparks) {
      const x = px(sp.a, sp.r);
      const y = py(sp.a, sp.r);
      const color = POLARITY_COLOR[sp.pol];
      const tailR = Math.min(1, sp.r + 0.03 + sp.speed * 0.25);
      const tx = px(sp.a, tailR);
      const ty = py(sp.a, tailR);
      const tail = ctx.createLinearGradient(x, y, tx, ty);
      tail.addColorStop(0, rgba(color, 0.55));
      tail.addColorStop(1, rgba(color, 0));
      ctx.strokeStyle = tail;
      ctx.lineWidth = size * 0.7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      ctx.shadowColor = color;
      ctx.shadowBlur = size * 1.6;
      drawPolarityShape(x, y, size, sp.pol, clock * 1.4 + sp.id);
      ctx.shadowBlur = 0;
    }
  }

  function drawBolts(state) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.ink;
    ctx.shadowColor = PALETTE.lime;
    ctx.shadowBlur = R * 0.04;
    ctx.lineWidth = Math.max(2.5, R * 0.011);
    for (const b of state.bolts) {
      const tail = Math.max(shieldRadius(b.player ?? 0), b.r - 0.1);
      ctx.beginPath();
      ctx.moveTo(px(b.a, tail), py(b.a, tail));
      ctx.lineTo(px(b.a, Math.min(b.r, 1.02)), py(b.a, Math.min(b.r, 1.02)));
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  /**
   * One player's shield. Colour and fill show the polarity, so with two
   * players the owner is shown by other means: the orbit (player 1 inside,
   * player 2 outside), a numbered badge, and a pulse when the player joins
   * and first turns the knob.
   */
  function drawShield(state, index, numbered) {
    const player = state.players[index];
    const radius = shieldRadius(index);
    const a = player.shieldAngle;
    const half = ARENA.SHIELD_HALF_ARC_DEG;
    const color = POLARITY_COLOR[player.polarity];
    const flashing = shieldFlash[index];
    const pulsing = joinPulse[index] > 0;
    const throb = pulsing ? 0.5 + 0.5 * Math.sin(clock * 13) : 0;

    if (pulsing) {
      ctx.strokeStyle = rgba(PALETTE.ink, 0.2 + 0.35 * throb);
      ctx.lineCap = 'round';
      ctx.lineWidth = R * (0.05 + 0.04 * throb);
      arc(radius, a - half, a + half);
    }

    ctx.shadowColor = color;
    ctx.shadowBlur = R * (0.03 + 0.05 * flashing);
    ctx.strokeStyle = color;
    if (player.polarity === 1) {
      // Filled polarity: one solid band.
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(5, R * 0.03);
      arc(radius, a - half, a + half);
    } else {
      // Hollow polarity: the outline of the same band.
      const t = 0.014;
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(2, R * 0.008);
      ctx.beginPath();
      ctx.arc(cx, cy, R * (radius + t), (a - half - 90) * DEG, (a + half - 90) * DEG);
      ctx.arc(cx, cy, R * (radius - t), (a + half - 90) * DEG, (a - half - 90) * DEG, true);
      ctx.closePath();
      ctx.stroke();
    }
    if (flashing > 0.02) {
      ctx.strokeStyle = rgba(PALETTE.ink, flashing * 0.8);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(3, R * 0.012);
      arc(radius, a - half, a + half);
    }
    ctx.shadowBlur = 0;
    if (!numbered) return;

    // Numbered badge in the middle of the arc.
    const bx = px(a, radius);
    const by = py(a, radius);
    const size = Math.max(10, R * 0.03) * (1 + 0.45 * throb);
    ctx.fillStyle = '#02120E';
    ctx.strokeStyle = pulsing ? PALETTE.ink : color;
    ctx.lineWidth = Math.max(2, R * 0.006);
    ctx.beginPath();
    ctx.arc(bx, by, size, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = PALETTE.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(size * 1.35)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(String(index + 1), bx, by + size * 0.06);

    if (pulsing) {
      const lr = radius + 0.1;
      ctx.font = `800 ${Math.max(14, Math.round(R * 0.05))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.shadowColor = '#02120E';
      ctx.shadowBlur = 8;
      ctx.fillStyle = rgba(PALETTE.ink, Math.min(1, joinPulse[index] * 2));
      ctx.fillText(`SPILLER ${index + 1}`, px(a, lr), py(a, lr));
      ctx.shadowBlur = 0;
    }
  }

  /** A thin breath gauge hugging the core: player 1 inside, player 2 outside. */
  function drawBreathArc(state, index) {
    const player = state.players[index];
    const r = index === 0 ? 0.118 : 0.152;
    const share = player.breath / RULES.BREATH_MAX;
    const ready = player.breath >= RULES.SHOCK_COST;
    const flashing = breathFlash[index];
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(2, R * 0.0075);
    ctx.strokeStyle = rgba(PALETTE.ink, 0.1);
    arc(r, 0, 360);
    if (share > 0.004) {
      const color = flashing > 0.05 ? PALETTE.red : PALETTE.lime;
      ctx.strokeStyle = rgba(color, ready ? 0.95 : 0.5);
      arc(r, 0, 360 * share);
    } else if (flashing > 0.05) {
      ctx.strokeStyle = rgba(PALETTE.red, flashing);
      arc(r, 0, 360);
    }
    // Notch at the shockwave cost: above it a clap releases a shockwave.
    const notch = (RULES.SHOCK_COST / RULES.BREATH_MAX) * 360;
    ctx.strokeStyle = rgba(PALETTE.ink, 0.7);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px(notch, r - 0.013), py(notch, r - 0.013));
    ctx.lineTo(px(notch, r + 0.013), py(notch, r + 0.013));
    ctx.stroke();
  }

  function drawCore(state, solo) {
    const alive = state.health > 0;
    const beat = 1 + 0.03 * Math.sin(clock * 3.2) + 0.1 * micShown;
    const haloR = R * ARENA.CORE_R * (2.4 + 2.2 * micShown);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    const haloColor = coreFlash > 0.05 || !alive ? PALETTE.red : PALETTE.teal;
    halo.addColorStop(0, rgba(haloColor, 0.75));
    halo.addColorStop(1, rgba(haloColor, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, TAU);
    ctx.fill();

    const coreR = R * ARENA.CORE_R * beat;
    const body = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, coreR * 0.1, cx, cy, coreR);
    if (alive) {
      body.addColorStop(0, '#0f6b46');
      body.addColorStop(1, '#063a2b');
    } else {
      body.addColorStop(0, '#3a1512');
      body.addColorStop(1, '#1c0b09');
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();
    ctx.lineWidth = Math.max(2, R * 0.007);
    ctx.strokeStyle = coreFlash > 0.05 ? rgba(PALETTE.red, 0.5 + 0.5 * coreFlash) : rgba(healthColor(state.health), 0.95);
    ctx.stroke();

    // Alone, the core shows the shield's polarity: the same shape the knob
    // shows. With two players each shield speaks for itself.
    if (alive && solo) drawPolarityShape(cx, cy, coreR * 0.36, state.players[0].polarity, 0);
  }

  function drawParticles(dt) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - Math.min(1, dt * 2.2);
      p.vy *= 1 - Math.min(1, dt * 2.2);
      const k = p.life / p.max;
      ctx.fillStyle = rgba(p.color, k);
      ctx.beginPath();
      ctx.arc(cx + p.x * R, cy + p.y * R, Math.max(1, p.size * R * k), 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawFloats(dt) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.max(13, Math.round(R * 0.05))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.life -= dt;
      if (f.life <= 0) {
        floats.splice(i, 1);
        continue;
      }
      f.r += dt * 0.09;
      ctx.fillStyle = rgba(f.color, Math.min(1, (f.life / f.max) * 1.6));
      ctx.fillText(f.text, px(f.a, f.r), py(f.a, f.r));
    }
  }

  /**
   * Draws one frame.
   * @param {object} state  game state from the rules
   * @param {{ micLevel: number }} view  calibrated mic level 0..1
   * @param {number} dt  seconds since the previous frame
   */
  function draw(state, view, dt) {
    const frozen = state.phase === PHASE.PAUSED;
    const animDt = frozen ? 0 : dt;
    clock += animDt;
    const decay = (v, rate) => v * Math.exp(-dt * rate);
    shake = decay(shake, 9);
    flash = decay(flash, 7);
    coreFlash = decay(coreFlash, 5);
    const joined = joinedPlayers(state);
    for (let i = 0; i < shieldFlash.length; i++) {
      shieldFlash[i] = decay(shieldFlash[i], 8);
      breathFlash[i] = decay(breathFlash[i], 3);
      joinPulse[i] = Math.max(0, joinPulse[i] - dt);
      const target = state.players[i].shieldTarget;
      if (awaitingTurn[i] && lastTarget[i] !== null && target !== lastTarget[i]) {
        awaitingTurn[i] = false;
        joinPulse[i] = JOIN_PULSE_S;
      }
      lastTarget[i] = target;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.drawImage(background, 0, 0, width, height);

    ctx.save();
    if (shake > 0.4 && !frozen) {
      ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
    }
    drawHealthRim(state);
    drawMicRings(state, view.micLevel, dt);
    drawShocks(state);
    for (const i of joined) drawAim(state, i);
    drawSparks(state);
    drawBolts(state);
    drawCore(state, joined.length === 1);
    for (const i of joined) drawBreathArc(state, i);
    for (const i of joined) drawShield(state, i, joined.length > 1);
    drawParticles(animDt);
    drawFloats(animDt);
    ctx.restore();

    if (flash > 0.01) {
      ctx.fillStyle = rgba(PALETTE.ink, flash);
      ctx.fillRect(0, 0, width, height);
    }
    if (state.phase === PHASE.PAUSED || state.phase === PHASE.OVER) {
      ctx.fillStyle = rgba('#02120E', 0.55);
      ctx.fillRect(0, 0, width, height);
    }
  }

  resize();
  return { resize, addEffects, draw };
}
