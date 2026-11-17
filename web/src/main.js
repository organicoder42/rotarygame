// Wiring: knobs + keyboard + microphones -> rules -> canvas, DOM and knobs.
// The rules (game.js), the wire contract (protocol.js) and the microphone
// calibration (mic.js) are pure; this file only moves data between them.
//
// There is one "slot" per player. A slot owns everything that belongs to one
// knob: its serial link, counter decoder, hud and haptic pacing, microphone
// calibration and its row in the status area.

import { HAPTIC_CUES, KEYBOARD_MIC, MIC, RULES } from './config.js';
import { PHASE, createGame, effectPlayers, hudValues, joinedPlayers, leader, multiplier, step, teamScore } from './game.js';
import { attachKeyboard } from './keyboard.js';
import { createMic, micBeginCalibration, micIsCalibrating, micRawForLevel, micSample } from './mic.js';
import { HapticLimiter, HudScheduler, InputDecoder, formatHap, formatHud, parseLine } from './protocol.js';
import { createRenderer } from './render.js';
import { SerialLink } from './serial.js';

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('arena'),
  team: $('team'),
  best: $('best'),
  barHealth: $('bar-health'),
  valHealth: $('val-health'),
  remove2: $('remove-2'),
  message: $('message'),
  hint: $('hint'),
  debug: $('debug'),
};

/** Status line of knob `n` (1 or 2). `joined` = that player is in the game. */
function statusText(n, state, detail, joined) {
  switch (`${state}:${detail ?? ''}`) {
    case 'unsupported:':
      return n === 1
        ? 'Denne browser har ikke Web Serial. Brug Chrome eller Edge på en computer – indtil da kan du spille med tastaturet.'
        : 'Spiller 2 kan være med på tastaturet: A D W S Q E';
    case 'connecting:':
      return 'Åbner forbindelsen …';
    case 'handshake:':
      return `Knap ${n}: forbundet – venter på svar …`;
    case 'handshake:slow':
      return `Porten er åben, men knap ${n} svarer ikke. Er Ekko-firmwaren lagt på?`;
    case 'ready:':
      return `Knap ${n} er forbundet`;
    case 'ready:version':
      return `Knap ${n} svarer med en anden protokolversion – opdatér firmwaren`;
    case 'lost:':
      return `Forbindelsen til knap ${n} røg – sæt kablet i igen`;
    case 'error:busy':
      return 'Porten er optaget. Luk andre programmer, der bruger knappen (fx en seriel monitor), og prøv igen.';
    case 'error:taken':
      return `Den knap tilhører allerede spiller ${n === 1 ? 2 : 1} – vælg den anden på listen`;
    case 'error:open-failed':
      return 'Kunne ikke åbne porten – prøv igen';
    default:
      if (n === 1) return 'Knap 1 er ikke forbundet – tastaturet virker';
      return joined ? 'Spiller 2 er med på tastaturet' : 'Spiller 2: tilslut en knap til, eller tryk A D W S Q E';
  }
}

const HINT = {
  calibrating: 'Shh … vær stille et øjeblik – spillet måler rummets støj',
  aim: 'Drej skjoldet ind foran gnisterne',
  aimDuo: 'Drej jeres skjolde ind foran gnisterne',
  wrongPolarity: 'Forkert polaritet – tryk på den lille cirkel for at skifte',
  breathOut: 'Pusten er brugt op – den fylder op igen, når der er stille',
  shockDenied: 'Ikke nok pust til en chokbølge',
  joined: (n) => `Spiller ${n} er med – drej knappen og se, hvilket skjold der blinker`,
};

// ---------- state ----------

const renderer = createRenderer(el.canvas);
let game = createGame((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
/** Input events waiting for the next frame. */
const pending = [];

const slots = [0, 1].map((index) => ({
  index,
  n: index + 1,
  link: null,
  decoder: new InputDecoder(),
  hud: new HudScheduler(),
  haptics: new HapticLimiter(),
  mic: createMic(),
  /** Counters are trusted only after the device answered `hello`. */
  helloSeen: false,
  status: { state: 'idle', detail: undefined },
  slowHandshakeTimer: null,
  lastDeviceSample: -Infinity,
  lastKeyboardSample: -Infinity,
  clapKeySamples: 0,
  wrongPolarityHints: 0,
  debug: { line: '–', state: null, micSource: 'tastatur', lineTimes: [], rejected: 0, lastHud: '–', lastHap: '–' },
  el: {
    connect: $(`connect-${index + 1}`),
    status: $(`status-${index + 1}`),
    statusText: $(`status-text-${index + 1}`),
    score: $(`score-${index + 1}`),
    combo: $(`combo-${index + 1}`),
    barBreath: $(`bar-breath-${index + 1}`),
    valBreath: $(`val-breath-${index + 1}`),
    barMic: $(`bar-mic-${index + 1}`),
  },
}));

const best = { solo: loadBest('ekko.best'), team: loadBest('ekko.best.team') };
let newRecord = false;
let hint = { text: '', until: 0, anyPhase: false };
let lastFrame = performance.now();
let debugVisible = false;
let fps = 0;

const isJoined = (index) => game.players[index].joined;
const isDuo = () => joinedPlayers(game).length > 1;
const isConnected = (slot) => ['connecting', 'handshake', 'ready'].includes(slot.link.state);

// ---------- persistence ----------

function loadBest(key) {
  try {
    return Math.max(0, Number(localStorage.getItem(key)) || 0);
  } catch {
    return 0;
  }
}

function saveBest(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private window: the record just lives until the tab closes
  }
}

// ---------- players ----------

/** A knob that speaks the protocol, or a player-2 key, brings player 2 in. */
function ensureJoined(index) {
  if (index !== 0 && !isJoined(index)) pending.push({ type: 'join', player: index });
}

// ---------- microphones ----------

/** One raw sample (device or simulated) through calibration into the game. */
function feedMic(slot, raw, now) {
  let value = raw;
  // The keyboard adds noise on top of whatever the room sounds like, through
  // the same calibration path as the real microphone.
  if (slot.mic.floor !== null && !micIsCalibrating(slot.mic)) {
    if (keys.blowing[slot.index]) value = Math.max(value, micRawForLevel(slot.mic, KEYBOARD_MIC.BLOW_LEVEL));
    if (slot.clapKeySamples > 0) {
      slot.clapKeySamples -= 1;
      value = Math.max(value, Math.min(0, micRawForLevel(slot.mic, KEYBOARD_MIC.CLAP_LEVEL)));
    }
  }
  const result = micSample(slot.mic, value, now);
  slot.mic = result.mic;
  pending.push({ type: 'mic', player: slot.index, level: result.level });
  if (result.clap) pending.push({ type: 'clap', player: slot.index });
}

/** A player without a device gets a simulated quiet room for the keyboard. */
function simulateMic(slot, now) {
  if (!isJoined(slot.index)) return;
  if (now - slot.lastDeviceSample < 250) return;
  if (now - slot.lastKeyboardSample < KEYBOARD_MIC.SAMPLE_MS) return;
  slot.lastKeyboardSample = now;
  slot.debug.micSource = 'tastatur';
  feedMic(slot, KEYBOARD_MIC.QUIET_CDB + (Math.random() * 2 - 1) * KEYBOARD_MIC.JITTER_CDB, now);
}

// ---------- serial links ----------

function onLine(slot, line) {
  // Lines still in flight after a disconnect must not bring the player back.
  if (slot.link.state !== 'handshake' && slot.link.state !== 'ready') return;
  const now = performance.now();
  slot.debug.line = line;
  const msg = parseLine(line);
  if (!msg) {
    slot.debug.rejected += 1;
    return;
  }
  ensureJoined(slot.index);
  if (msg.type === 'hello') {
    // A stale `!s` line may arrive before the answer: start counting afresh.
    slot.helloSeen = true;
    slot.decoder.reset();
    return;
  }
  slot.debug.state = msg;
  slot.debug.lineTimes.push(now);
  if (slot.helloSeen) {
    for (const event of slot.decoder.push(msg).events) pending.push({ ...event, player: slot.index });
  }
  slot.lastDeviceSample = now;
  slot.debug.micSource = 'knap';
  feedMic(slot, msg.m, now);
}

function onStatus(slot, { state, detail }) {
  clearTimeout(slot.slowHandshakeTimer);
  if (state === 'handshake') {
    slot.helloSeen = false;
    slot.decoder.reset();
    slot.hud.reset();
    slot.haptics.reset();
    slot.slowHandshakeTimer = setTimeout(() => {
      if (slot.link.state === 'handshake') showStatus(slot, 'handshake', 'slow');
    }, 4000);
  } else if (state !== 'ready' && state !== 'connecting') {
    slot.decoder.reset();
    // Do not let the game run on while a controller is gone.
    if (state === 'lost') pending.push({ type: 'pause' });
  }
  showStatus(slot, state, detail);
}

for (const slot of slots) {
  // Created in slot order: the serial shell hands a returning knob back to
  // the slot that lost it.
  slot.link = new SerialLink({
    onLine: (line) => onLine(slot, line),
    onStatus: (status) => onStatus(slot, status),
  });
  slot.el.connect.addEventListener('click', () => {
    slot.el.connect.blur();
    if (isConnected(slot)) slot.link.disconnect();
    else slot.link.connect();
  });
}

el.remove2.addEventListener('click', () => {
  el.remove2.blur();
  const slot = slots[1];
  if (isConnected(slot) || slot.link.state === 'lost') slot.link.disconnect();
  pending.push({ type: 'leave', player: 1 });
});

function showStatus(slot, state, detail) {
  slot.status = { state, detail };
  refreshStatus(slot);
}

function refreshStatus(slot) {
  const { state, detail } = slot.status;
  const connected = isConnected(slot);
  slot.el.status.dataset.state = state === 'idle' && slot.index === 1 && isJoined(1) ? 'keyboard' : state;
  slot.el.statusText.textContent = statusText(slot.n, state, detail, isJoined(slot.index));
  slot.el.connect.dataset.connected = String(connected);
  slot.el.connect.textContent = connected
    ? `Afbryd knap ${slot.n}`
    : slot.index === 0
      ? 'Forbind knap 1'
      : 'Tilslut knap 2';
  slot.el.connect.disabled = state === 'unsupported';
}

/** Sends what the contract allows right now, per knob: one haptic cue and/or its hud. */
function pumpLinks(now) {
  for (const slot of slots) {
    if (!slot.link.isOpen) continue;
    const effect = slot.haptics.poll(now);
    if (effect !== null) {
      const line = formatHap(effect);
      if (line && slot.link.send(line)) slot.debug.lastHap = line;
    }
    const line = slot.hud.poll(formatHud(hudValues(game, slot.index)), now);
    if (line) {
      slot.link.send(line);
      slot.debug.lastHud = line;
    }
  }
}

// ---------- effects ----------

function showHint(text, ms, now, anyPhase = false) {
  hint = { text, until: now + ms, anyPhase };
}

/** With two players a hint says whom it is for. */
const forPlayer = (e, text) => (isDuo() ? `Spiller ${(e.player ?? 0) + 1}: ${text}` : text);

function handleEffects(effects, now) {
  for (const e of effects) {
    const cue = HAPTIC_CUES[e.type];
    if (cue && cue.effect) {
      for (const index of effectPlayers(e, game)) {
        const slot = slots[index];
        if (slot.link.isOpen) slot.haptics.offer(cue.effect, cue.priority, now);
      }
    }

    switch (e.type) {
      case 'start':
        for (const slot of slots) {
          slot.mic = micBeginCalibration(slot.mic, now);
          slot.wrongPolarityHints = 0;
        }
        newRecord = false;
        showHint(HINT.calibrating, MIC.CALIBRATION_MS, now);
        break;
      case 'join':
        slots[e.player].mic = createMic();
        showHint(HINT.joined(e.player + 1), 4500, now, true);
        break;
      case 'absorb':
        if ([HINT.aim, HINT.aimDuo].includes(hint.text) || hint.text.endsWith(HINT.wrongPolarity)) hint.until = 0;
        break;
      case 'pass': {
        const slot = slots[e.player ?? 0];
        if (slot.wrongPolarityHints < 3) {
          slot.wrongPolarityHints += 1;
          showHint(forPlayer(e, HINT.wrongPolarity), 2600, now);
        }
        break;
      }
      case 'breathOut':
        showHint(forPlayer(e, HINT.breathOut), 2600, now);
        break;
      case 'shockDenied':
        showHint(forPlayer(e, HINT.shockDenied), 1600, now);
        break;
      case 'gameOver': {
        hint.until = 0;
        const key = isDuo() ? 'team' : 'solo';
        if (e.score > best[key]) {
          best[key] = e.score;
          newRecord = true;
          saveBest(key === 'team' ? 'ekko.best.team' : 'ekko.best', e.score);
        }
        break;
      }
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
  const duo = isDuo();
  switch (game.phase) {
    case PHASE.READY:
      return (
        '<h2>Klar?</h2>' +
        `<p class="cta">${duo ? 'Hold fingeren på en af knappernes skærm for at starte' : 'Hold fingeren på knappens skærm for at starte'}</p>` +
        '<p class="sub">Uden knap: tryk Enter</p>'
      );
    case PHASE.PAUSED:
      return '<h2>Pause</h2><p class="cta">Langt tryk for at fortsætte</p>';
    case PHASE.OVER: {
      const [a, b] = game.players;
      if (!duo) {
        return (
          '<h2>Kernen er slukket</h2>' +
          `<p class="big">${a.score}</p>` +
          `<p>${newRecord ? 'Ny rekord!' : `Bedste: ${best.solo}`}</p>` +
          `<p class="sub">Fanget ${a.stats.absorbed} · Skudt ${a.stats.bolted} · Blæst væk ${a.stats.shocked} · Længste kombo ${a.bestCombo}</p>` +
          '<p class="cta">Langt tryk for at prøve igen</p>'
        );
      }
      const first = leader(game);
      return (
        '<h2>Kernen er slukket</h2>' +
        `<p class="duel"><span>Spiller 1<b>${a.score}</b></span><span>Spiller 2<b>${b.score}</b></span></p>` +
        `<p class="lead">${first < 0 ? 'Uafgjort!' : `Spiller ${first + 1} scorede mest!`}</p>` +
        `<p>Holdet fik <b>${teamScore(game)}</b> point · ${newRecord ? 'ny holdrekord!' : `bedste hold: ${best.team}`}</p>` +
        '<p class="cta">Langt tryk for at prøve igen</p>'
      );
    }
    default:
      return '';
  }
}

function updateDom(now) {
  const duo = isDuo();
  put('phase', game.phase, (v) => {
    document.body.dataset.phase = v;
  });
  put('players', duo ? '2' : '1', (v) => {
    document.body.dataset.players = v;
  });
  put('p2', `${isJoined(1)}|${slots[1].status.state}`, () => {
    el.remove2.hidden = !isJoined(1);
    refreshStatus(slots[1]);
  });
  const total = teamScore(game);
  put('message', `${game.phase}|${duo}|${total}|${game.players[1].score}|${best.solo}|${best.team}|${newRecord}`, () => {
    el.message.innerHTML = messageHtml();
  });
  put('team', total, (v) => {
    el.team.textContent = String(v);
  });
  put('best', Math.max(duo ? best.team : best.solo, total), (v) => {
    el.best.textContent = String(v);
  });
  const first = duo ? leader(game) : -1;

  for (const slot of slots) {
    const p = game.players[slot.index];
    const id = slot.index;
    put(`score${id}`, p.score, (v) => {
      slot.el.score.textContent = String(v);
    });
    put(`lead${id}`, first === id && p.score > 0, (v) => {
      slot.el.score.parentElement.dataset.lead = String(v);
    });
    const mult = multiplier(p.combo);
    put(`combo${id}`, p.combo >= 2 ? `Kombo ${p.combo}${mult > 1 ? ` · ×${mult}` : ''}` : '', (v) => {
      slot.el.combo.textContent = v;
    });
    put(`breath${id}`, Math.round(p.breath), (v) => {
      slot.el.barBreath.style.width = `${v}%`;
      slot.el.barBreath.dataset.ready = String(v >= RULES.SHOCK_COST);
      slot.el.valBreath.textContent = String(v);
    });
    put(`mic${id}`, Math.round(slot.mic.level * 50) * 2, (v) => {
      slot.el.barMic.style.width = `${v}%`;
    });
  }

  put('health', Math.ceil(game.health), (v) => {
    el.barHealth.style.width = `${v}%`;
    el.barHealth.dataset.level = v > 60 ? 'high' : v > 30 ? 'mid' : 'low';
    el.valHealth.textContent = String(v);
  });

  // After the calibration notice, nudge the players towards their knobs.
  if (game.phase === PHASE.PLAYING && hint.text === HINT.calibrating && now >= hint.until) {
    showHint(duo ? HINT.aimDuo : HINT.aim, 5000, now);
  }
  const hintText = (game.phase === PHASE.PLAYING || hint.anyPhase) && now < hint.until ? hint.text : '';
  put('hint', hintText, (v) => {
    el.hint.textContent = v;
    el.hint.hidden = v === '';
  });
}

function updateDebug(now) {
  if (!debugVisible) return;
  const n = (v) => (v === null || v === undefined ? '–' : String(Math.round(v)));
  const lines = ['FEJLSØGNING (I skjuler)'];
  for (const slot of slots) {
    const d = slot.debug;
    const p = game.players[slot.index];
    while (d.lineTimes.length && now - d.lineTimes[0] > 1000) d.lineTimes.shift();
    const s = d.state;
    lines.push(
      `── KNAP ${slot.n} · spiller ${slot.n} ${p.joined ? 'er med' : 'er ikke med'} ──`,
      `forbindelse  ${slot.link.state}${slot.helloSeen ? '' : '  (intet hello)'}`,
      `sidste linje ${d.line}`,
      `!s k t z h m ${s ? `${s.k} ${s.t} ${s.z} ${s.h} ${s.m}` : '–'}`,
      `linjer/s     ${d.lineTimes.length}   afvist ${d.rejected}   resynk ${slot.decoder.resyncs}`,
      `mik          ${d.micSource}${slot.mic.valid ? '' : ' (intet signal)'}   rå ${n(slot.mic.raw)} cdB   gulv ${n(slot.mic.floor)} cdB${micIsCalibrating(slot.mic) ? ' (måler …)' : ''}`,
      `mik niveau   ${slot.mic.level.toFixed(2)}   øjeblik ${slot.mic.inst.toFixed(2)}   klap ${slot.mic.claps}   pust ${p.breath.toFixed(0)}${p.blowing ? ' (skubber)' : ''}`,
      `hud →        ${d.lastHud}`,
      `hap →        ${d.lastHap}   sendt ${slot.haptics.sent}   droppet ${slot.haptics.dropped}`,
    );
  }
  lines.push(`spil         ${game.phase}  ${game.time.toFixed(1)} s  gnister ${game.sparks.length}  ${fps.toFixed(0)} fps`);
  el.debug.textContent = lines.join('\n');
}

// ---------- input ----------

const keys = attachKeyboard({
  onEvent: (event) => pending.push(event),
  onPlayerKey: (player) => ensureJoined(player),
  onClap: (player) => {
    slots[player].clapKeySamples = 1;
  },
  onToggleDebug: () => {
    debugVisible = !debugVisible;
    el.debug.hidden = !debugVisible;
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
  if (elapsed > 0) fps += (1 / elapsed - fps) * 0.05;
  // A stalled tab must not turn into one giant step.
  const dt = Math.min(Math.max(elapsed, 0), 0.05);

  for (const slot of slots) simulateMic(slot, now);
  tick(dt, now);
  const micLevel = Math.max(...slots.map((slot) => (isJoined(slot.index) ? slot.mic.level : 0)));
  renderer.draw(game, { micLevel }, dt);
  updateDom(now);
  updateDebug(now);
  pumpLinks(now);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());

// Frames stop in a hidden tab: pause there and then, and keep the knobs'
// heartbeat alive from a timer so they do not show "not connected".
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastFrame = performance.now();
    return;
  }
  pending.push({ type: 'pause' });
  tick(0, performance.now());
  pumpLinks(performance.now());
});
setInterval(() => pumpLinks(performance.now()), 250);

for (const slot of slots) showStatus(slot, slot.link.state);
slots[0].link.reconnectKnown();
requestAnimationFrame(frame);
