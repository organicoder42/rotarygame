// Wiring: knob + keyboard + microphone -> rules -> canvas, DOM and knob.
// The rules (game.js), the wire contract (protocol.js) and the microphone
// calibration (mic.js) are pure; this file only moves data between them.

import { HAPTIC_CUES, KEYBOARD_MIC, MIC, RULES } from './config.js';
import { PHASE, createGame, multiplier, step } from './game.js';
import { attachKeyboard } from './keyboard.js';
import { createMic, micBeginCalibration, micIsCalibrating, micRawForLevel, micSample } from './mic.js';
import { HapticLimiter, HudScheduler, InputDecoder, formatHap, formatHud, parseLine } from './protocol.js';
import { createRenderer } from './render.js';
import { SerialLink } from './serial.js';

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('arena'),
  connect: $('connect'),
  status: $('status'),
  statusText: $('status-text'),
  score: $('score'),
  combo: $('combo'),
  best: $('best'),
  barHealth: $('bar-health'),
  barBreath: $('bar-breath'),
  barMic: $('bar-mic'),
  valHealth: $('val-health'),
  valBreath: $('val-breath'),
  message: $('message'),
  hint: $('hint'),
  debug: $('debug'),
};

const STATUS_TEXT = {
  unsupported:
    'Denne browser har ikke Web Serial. Brug Chrome eller Edge på en computer – indtil da kan du spille med tastaturet.',
  idle: 'Knappen er ikke forbundet – tastaturet virker',
  connecting: 'Åbner forbindelsen …',
  handshake: 'Forbundet – venter på svar fra knappen …',
  'handshake:slow': 'Porten er åben, men knappen svarer ikke. Er Ekko-firmwaren lagt på?',
  ready: 'Knappen er forbundet',
  'ready:version': 'Knappen svarer med en anden protokolversion – opdatér firmwaren',
  lost: 'Forbindelsen røg – sæt kablet i igen',
  error: 'Kunne ikke åbne porten – prøv igen',
  'error:busy':
    'Porten er optaget. Luk andre programmer, der bruger knappen (fx en seriel monitor), og prøv igen.',
};

const HINT = {
  calibrating: 'Shh … vær stille et øjeblik – spillet måler rummets støj',
  aim: 'Drej skjoldet ind foran gnisterne',
  wrongPolarity: 'Forkert polaritet – tryk på den lille cirkel for at skifte',
  breathOut: 'Pusten er brugt op – den fylder op igen, når der er stille',
  shockDenied: 'Ikke nok pust til en chokbølge',
};

// ---------- state ----------

const renderer = createRenderer(el.canvas);
let game = createGame((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
let mic = createMic();
const decoder = new InputDecoder();
const hud = new HudScheduler();
const haptics = new HapticLimiter();
/** Input events waiting for the next frame. */
const pending = [];

let best = loadBest();
let newRecord = false;
let hint = { text: '', until: 0 };
let wrongPolarityHints = 0;
let lastFrame = performance.now();
let lastDeviceSample = -Infinity;
let lastKeyboardSample = -Infinity;
let clapKeySamples = 0;
let slowHandshakeTimer = null;

const debug = {
  visible: false,
  line: '–',
  state: null,
  micSource: 'tastatur',
  lineTimes: [],
  rejected: 0,
  lastHud: '–',
  lastHap: '–',
  fps: 0,
};

// ---------- persistence ----------

function loadBest() {
  try {
    return Math.max(0, Number(localStorage.getItem('ekko.best')) || 0);
  } catch {
    return 0;
  }
}

function saveBest(value) {
  try {
    localStorage.setItem('ekko.best', String(value));
  } catch {
    // private window: the record just lives until the tab closes
  }
}

// ---------- microphone ----------

/** One raw sample (device or simulated) through calibration into the game. */
function feedMic(raw, now) {
  let value = raw;
  // The keyboard adds noise on top of whatever the room sounds like, through
  // the same calibration path as the real microphone.
  if (mic.floor !== null && !micIsCalibrating(mic)) {
    if (keys.blowing) value = Math.max(value, micRawForLevel(mic, KEYBOARD_MIC.BLOW_LEVEL));
    if (clapKeySamples > 0) {
      clapKeySamples -= 1;
      value = Math.max(value, Math.min(0, micRawForLevel(mic, KEYBOARD_MIC.CLAP_LEVEL)));
    }
  }
  const result = micSample(mic, value, now);
  mic = result.mic;
  pending.push({ type: 'mic', level: result.level });
  if (result.clap) pending.push({ type: 'clap' });
}

/** Without a device the keyboard alone drives a simulated quiet room. */
function simulateMic(now) {
  if (now - lastDeviceSample < 250) return;
  if (now - lastKeyboardSample < KEYBOARD_MIC.SAMPLE_MS) return;
  lastKeyboardSample = now;
  debug.micSource = 'tastatur';
  feedMic(KEYBOARD_MIC.QUIET_CDB + (Math.random() * 2 - 1) * KEYBOARD_MIC.JITTER_CDB, now);
}

// ---------- serial link ----------

const link = new SerialLink({
  onLine(line) {
    const now = performance.now();
    debug.line = line;
    const msg = parseLine(line);
    if (!msg) {
      debug.rejected += 1;
      return;
    }
    if (msg.type !== 'state') return;
    debug.state = msg;
    debug.lineTimes.push(now);
    for (const event of decoder.push(msg).events) pending.push(event);
    lastDeviceSample = now;
    debug.micSource = 'knap';
    feedMic(msg.m, now);
  },
  onStatus({ state, detail }) {
    clearTimeout(slowHandshakeTimer);
    if (state === 'handshake') {
      decoder.reset();
      hud.reset();
      haptics.reset();
      slowHandshakeTimer = setTimeout(() => {
        if (link.state === 'handshake') showStatus('handshake', 'slow');
      }, 4000);
    } else if (state !== 'ready' && state !== 'connecting') {
      decoder.reset();
      // Do not let the game run on while the controller is gone.
      if (state === 'lost') pending.push({ type: 'pause' });
    }
    showStatus(state, detail);
  },
});

function showStatus(state, detail) {
  el.status.dataset.state = state;
  el.statusText.textContent = STATUS_TEXT[`${state}:${detail}`] ?? STATUS_TEXT[state] ?? state;
  const connected = state === 'connecting' || state === 'handshake' || state === 'ready';
  el.connect.dataset.connected = String(connected);
  el.connect.textContent = connected ? 'Afbryd knappen' : 'Forbind knappen';
  el.connect.disabled = state === 'unsupported';
}

el.connect.addEventListener('click', () => {
  el.connect.blur();
  if (link.state === 'connecting' || link.state === 'handshake' || link.state === 'ready') link.disconnect();
  else link.connect();
});

/** Sends what the contract allows right now: one haptic cue and/or the hud. */
function pumpLink(now) {
  if (!link.isOpen) return;
  const effect = haptics.poll(now);
  if (effect !== null) {
    const line = formatHap(effect);
    if (line && link.send(line)) debug.lastHap = line;
  }
  const line = hud.poll(formatHud(game), now);
  if (line) {
    link.send(line);
    debug.lastHud = line;
  }
}

// ---------- effects ----------

function showHint(text, ms, now) {
  hint = { text, until: now + ms };
}

function handleEffects(effects, now) {
  for (const e of effects) {
    const cue = HAPTIC_CUES[e.type];
    if (cue && cue.effect && link.isOpen) haptics.offer(cue.effect, cue.priority, now);

    switch (e.type) {
      case 'start':
        mic = micBeginCalibration(mic, now);
        newRecord = false;
        wrongPolarityHints = 0;
        showHint(HINT.calibrating, MIC.CALIBRATION_MS, now);
        break;
      case 'absorb':
        if (hint.text === HINT.aim || hint.text === HINT.wrongPolarity) hint.until = 0;
        break;
      case 'pass':
        if (wrongPolarityHints < 3) {
          wrongPolarityHints += 1;
          showHint(HINT.wrongPolarity, 2600, now);
        }
        break;
      case 'breathOut':
        showHint(HINT.breathOut, 2600, now);
        break;
      case 'shockDenied':
        showHint(HINT.shockDenied, 1600, now);
        break;
      case 'gameOver':
        hint.until = 0;
        if (e.score > best) {
          best = e.score;
          newRecord = true;
          saveBest(best);
        }
        break;
      default:
        break;
    }
  }
  if (effects.length) renderer.addEffects(effects);
}

// ---------- DOM ----------

const shown = new Map();
/** Touches the DOM only when the value really changed. */
function put(key, value, apply) {
  if (shown.get(key) === value) return;
  shown.set(key, value);
  apply(value);
}

function messageHtml() {
  switch (game.phase) {
    case PHASE.READY:
      return (
        '<h2>Klar?</h2>' +
        '<p class="cta">Hold fingeren på knappens skærm for at starte</p>' +
        '<p class="sub">Uden knap: tryk Enter</p>'
      );
    case PHASE.PAUSED:
      return '<h2>Pause</h2><p class="cta">Langt tryk for at fortsætte</p>';
    case PHASE.OVER: {
      const s = game.stats;
      return (
        '<h2>Kernen er slukket</h2>' +
        `<p class="big">${game.score}</p>` +
        `<p>${newRecord ? 'Ny rekord!' : `Bedste: ${best}`}</p>` +
        `<p class="sub">Fanget ${s.absorbed} · Skudt ${s.bolted} · Blæst væk ${s.shocked} · Længste kombo ${game.bestCombo}</p>` +
        '<p class="cta">Langt tryk for at prøve igen</p>'
      );
    }
    default:
      return '';
  }
}

function updateDom(now) {
  put('phase', game.phase, (v) => {
    document.body.dataset.phase = v;
  });
  put('message', `${game.phase}|${game.score}|${best}|${newRecord}`, () => {
    el.message.innerHTML = messageHtml();
  });
  put('score', game.score, (v) => {
    el.score.textContent = String(v);
  });
  put('best', Math.max(best, game.score), (v) => {
    el.best.textContent = String(v);
  });
  const mult = multiplier(game.combo);
  put('combo', game.combo >= 2 ? `Kombo ${game.combo}${mult > 1 ? ` · ×${mult}` : ''}` : '', (v) => {
    el.combo.textContent = v;
    el.combo.hidden = v === '';
  });

  const health = Math.ceil(game.health);
  put('health', health, (v) => {
    el.barHealth.style.width = `${v}%`;
    el.barHealth.dataset.level = v > 60 ? 'high' : v > 30 ? 'mid' : 'low';
    el.valHealth.textContent = String(v);
  });
  put('breath', Math.round(game.breath), (v) => {
    el.barBreath.style.width = `${v}%`;
    el.barBreath.dataset.ready = String(v >= RULES.SHOCK_COST);
    el.valBreath.textContent = String(v);
  });
  put('mic', Math.round(mic.level * 50) * 2, (v) => {
    el.barMic.style.width = `${v}%`;
  });

  // After the calibration notice, nudge the player towards the knob.
  if (game.phase === PHASE.PLAYING && hint.text === HINT.calibrating && now >= hint.until) {
    showHint(HINT.aim, 5000, now);
  }
  const hintText = game.phase === PHASE.PLAYING && now < hint.until ? hint.text : '';
  put('hint', hintText, (v) => {
    el.hint.textContent = v;
    el.hint.hidden = v === '';
  });
}

function updateDebug(now) {
  if (!debug.visible) return;
  while (debug.lineTimes.length && now - debug.lineTimes[0] > 1000) debug.lineTimes.shift();
  const s = debug.state;
  const n = (v) => (v === null || v === undefined ? '–' : String(Math.round(v)));
  el.debug.textContent = [
    'FEJLSØGNING (D skjuler)',
    `forbindelse  ${link.state}`,
    `sidste linje ${debug.line}`,
    `!s k t z h m ${s ? `${s.k} ${s.t} ${s.z} ${s.h} ${s.m}` : '–'}`,
    `linjer/s     ${debug.lineTimes.length}   afvist ${debug.rejected}   resynk ${decoder.resyncs}`,
    `mik kilde    ${debug.micSource}${mic.valid ? '' : '  (intet signal)'}`,
    `mik rå       ${n(mic.raw)} cdB`,
    `støjgulv     ${n(mic.floor)} cdB${micIsCalibrating(mic) ? '  (måler …)' : ''}`,
    `mik niveau   ${mic.level.toFixed(2)}   øjeblik ${mic.inst.toFixed(2)}   klap ${mic.claps}`,
    `pust         ${game.breath.toFixed(0)}${game.blowing ? '  (skubber)' : ''}`,
    `hud →        ${debug.lastHud}`,
    `hap →        ${debug.lastHap}   sendt ${haptics.sent}   droppet ${haptics.dropped}`,
    `spil         ${game.phase}  ${game.time.toFixed(1)} s  gnister ${game.sparks.length}  ${debug.fps.toFixed(0)} fps`,
  ].join('\n');
}

// ---------- input ----------

const keys = attachKeyboard({
  onEvent: (event) => pending.push(event),
  onClap: () => {
    clapKeySamples = 1;
  },
  onToggleDebug: () => {
    debug.visible = !debug.visible;
    el.debug.hidden = !debug.visible;
  },
  onToggleFullscreen: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  },
});

/** Runs the rules once and lets every consumer see the result. */
function tick(dt, now) {
  const result = step(game, pending.splice(0), dt);
  game = result.state;
  handleEffects(result.effects, now);
}

// ---------- loops ----------

function frame(now) {
  const elapsed = (now - lastFrame) / 1000;
  lastFrame = now;
  if (elapsed > 0) debug.fps += (1 / elapsed - debug.fps) * 0.05;
  // A stalled tab must not turn into one giant step.
  const dt = Math.min(Math.max(elapsed, 0), 0.05);

  simulateMic(now);
  tick(dt, now);
  renderer.draw(game, { micLevel: mic.level }, dt);
  updateDom(now);
  updateDebug(now);
  pumpLink(now);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());

// Frames stop in a hidden tab: pause there and then, and keep the knob's
// heartbeat alive from a timer so it does not show "not connected".
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastFrame = performance.now();
    return;
  }
  pending.push({ type: 'pause' });
  tick(0, performance.now());
  pumpLink(performance.now());
});
setInterval(() => pumpLink(performance.now()), 250);

showStatus(link.state);
link.reconnectKnown();
requestAnimationFrame(frame);
