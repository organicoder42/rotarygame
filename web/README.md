# Ekko – web

The browser half of Ekko: an arcade game in Chrome, controlled by the knob over USB (Web Serial).
The wire contract is `../PROTOCOL.md`. Plain static files, no build step, no dependencies, no network.

## Run

```sh
cd knob-game/web
python3 -m http.server 8000
```

Open <http://localhost:8000> in Chrome (or Edge) on a laptop, plug in the knob and press
**Forbind knappen**. Web Serial needs `http://localhost` or https; opening `index.html` as a file
does not work.

- Only one program can hold the port. Close serial monitors before connecting, and press
  **Afbryd knappen** before flashing: the page then leaves the port alone until you connect again.
- After a cable pull the page reconnects by itself when the knob comes back, and after a reload it
  reopens a knob it was already allowed to use.
- The game makes no sound on purpose: the microphone sits next to the laptop.

Tests (Node 22, no install step):

```sh
node --test
```

## Controls

| Knob | Keyboard | Effect |
|---|---|---|
| Turn | Left / Right | Move the shield around the core, one step per detent |
| Tap the screen | Space | Fire a bolt along the shield; destroys the first spark in its path |
| Tap the small circle | X | Flip the shield's polarity (filled amber / hollow lime) |
| Blow or shout | hold M | Push the sparks outward; drains the breath meter |
| Clap (sudden loud peak) | N | Shockwave; needs and costs half the breath meter |
| Long press | Enter | Start, pause, resume, restart |
| | D | Debug overlay: raw `!s` values, noise floor, calibrated mic level, last `hud`/`hap` |
| | F | Full screen |

Keyboard and knob work at the same time. The shield only absorbs sparks of its own polarity; the
others fly straight through and must be shot or blown away. The game asks for a moment of silence
at every start while it measures the room's noise floor. N does nothing while M is held, exactly
as a clap is not heard while somebody is blowing.

## Files

| File | Role |
|---|---|
| `index.html`, `style.css` | Page, panels and all on-screen text outside the canvas |
| `src/config.js` | **Every tuning constant** |
| `src/game.js` | Game rules, pure: `step(state, events, dt) -> { state, effects }` |
| `src/mic.js` | Microphone calibration, pure: noise floor, 0..1 level, clap detection |
| `src/protocol.js` | Wire contract, pure: parse `!s`/`!hello`, counter differences, `hud`/`hap`, rate limits, line splitting |
| `src/serial.js` | Web Serial shell: port, read loop, `hello` retry, unplug and reconnect |
| `src/render.js` | Canvas renderer and decoration (particles, rings, shake) |
| `src/keyboard.js` | Keyboard stand-in for the knob |
| `src/main.js` | Wiring, DOM updates, Danish texts, debug overlay |
| `test/*.test.js` | `node --test` suites for the three pure modules |

## Tuning

Everything is in `src/config.js`, grouped:

- `CONTROL.DETENT_DEG` – degrees per knob detent (12 assumes 30 detents per revolution; set it to
  360 / the real count).
- `MIC` – `MARGIN_CDB` (how far above the noise floor silence ends), `SPAN_CDB` (how far above it
  full strength is), `CLAP_MIN_LEVEL` / `CLAP_PREV_MAX` (what counts as a clap), floor tracking
  speeds, `CALIBRATION_MS`. Watch the debug overlay (D) while adjusting.
- `RULES` – difficulty curve (`RAMP_S`, spawn interval, spark speed), damage, scoring, bolt
  cooldown, breath drain/refill, push strength, shockwave cost and radius.
- `WAVEFORM` and `HAPTIC_CUES` – DRV2605L waveform numbers and which game event plays which
  (effect 0 = no cue).
- `LINK` – USB vendor id, `hud`/`hap` pacing, `hello` retry, plausibility limits for counter jumps.
- `ARENA`, `KEYBOARD_MIC` – geometry and the keyboard's simulated microphone.

Colours are in `PALETTE` at the top of `src/render.js` and in `:root` in `style.css`.
