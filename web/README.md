# Ekko – web

The browser half of Ekko: an arcade game in Chrome for one or two players, each with a knob over
USB (Web Serial) or wirelessly over Bluetooth LE (Web Bluetooth). The wire contract is
`../PROTOCOL.md`. Plain static files, no build step, no dependencies, no network.

## Run

```sh
cd knob-game/web
python3 -m http.server 8000
```

Open <http://localhost:8000> in Chrome (or Edge) on a laptop, plug in the knob and press
**Kabel** under *Forbind knap 1 med*. Web Serial and Web Bluetooth need `http://localhost` or
https; opening `index.html` as a file does not work.

- Only one program can hold a port. Close serial monitors before connecting, and press
  **Afbryd knap N** before flashing: the page then leaves that port alone until you connect again.
- After a cable pull the page reconnects by itself when the knob comes back. After a reload it
  reopens knob 1 by itself only if exactly one permitted knob is plugged in; otherwise press the
  buttons again.
- The game makes no sound on purpose: the microphones sit next to the laptop.

## Wireless (Bluetooth)

Each player chooses **Kabel** or **Bluetooth** for their own knob; one of each is fine.

1. Give the knob power through its USB-C socket. It has no battery, so it still needs a cable for
   power, but any charger or power bank will do and it does not have to be the laptop.
2. Press **Bluetooth** under *Forbind knap 1 med* (or *Tilslut knap 2 med*). Chrome lists the knobs
   in range as `Ekko-XXXX`; the same name is on the knob's own "not connected" screen. Pick yours
   and confirm.
3. The status line shows the name: *Knap 1 (Ekko-3F2A) er forbundet trådløst*.

Good to know:

- **Chrome or Edge is required.** Firefox and Safari have no Web Bluetooth (and no Web Serial); the
  buttons are then greyed out and the keyboard still works.
- **macOS asks for permission.** The first time, macOS asks whether Chrome may use Bluetooth. Say
  yes; if it was declined, turn it on in System Settings → Privacy & Security → Bluetooth (Chrome
  may need a restart). Bluetooth itself must be switched on.
- **If the link drops** (out of range, power pulled) the game pauses and the page reconnects by
  itself, waiting a little longer between attempts, for as long as the page is open. The player
  keeps their number. **Afbryd knap N** stops the attempts.
- **After a page reload the knob must be picked again.** Chrome does not keep the permission for a
  Bluetooth device across a reload, so the status line asks you to press **Bluetooth** and pick
  `Ekko-XXXX` once more. (A knob on a cable is reopened without a click, see above.)
- A knob takes one connection at a time. A knob that already belongs to the other player is
  refused with a message.
- To go from cable to Bluetooth or back, press **Afbryd knap N** and choose the other one. A knob
  that is powered from the laptop can be used either way.
- `I` shows the write queue per wireless knob: lines sent, `hud` lines replaced by a newer one,
  `hap` cues skipped because they waited too long, failed writes and reconnections.

Tests (Node 22, no install step):

```sh
node --test
```

## Two players

Co-op with a score race: one arena, one shared core, and each player has their own shield,
polarity, breath meter, combo and score. Until player 2 joins, the game is the single-player game.

- **Join:** press **Kabel** or **Bluetooth** under *Tilslut knap 2 med* and pick the second knob in
  Chrome's list (each knob needs its own click), or press any player-2 key. **Fjern spiller 2**
  goes back to one player.
- **Player number = the buttons you used.** The knob connected under *Forbind knap 1 med* is
  player 1, whether by cable or Bluetooth. A knob that is unplugged and plugged in again, or whose
  Bluetooth link drops and comes back, returns to its slot.
- **Which shield is mine:** shield 1 orbits inside, shield 2 outside, each carries its number, and
  a shield pulses with a "SPILLER N" label when its player joins and the first time they turn the
  knob afterwards. Colour and fill mean polarity, never player.
- A long press on either knob starts, pauses, resumes and restarts.
- A spark meets the outer shield (player 2) first; what passes it can still be caught by the inner
  one. A hit on the core costs the shared health and breaks both combos.
- Both microphones hear the same room. Each player's noise drains their own breath, and the pushes
  add up. One clap heard by both knobs is one shockwave, paid for by the knob that reported it first.
- Sparks come more often and in two streams, one starting near each player's shield.
- Each knob shows its own score, breath and polarity plus the shared health and phase, and feels
  its own player's haptics; a hit on the core and game over go to both.

## Controls

| Knob | Player 1 keys | Player 2 keys | Effect |
|---|---|---|---|
| Turn | Left / Right | A / D | Move your shield around the core, one step per detent |
| Tap the screen | Space | W | Fire a bolt along your shield; destroys the first spark in its path |
| Tap the small circle | X | S | Flip your shield's polarity (filled amber / hollow lime) |
| Blow or shout | hold M | hold Q | Push the sparks outward; drains your breath meter |
| Clap (sudden loud peak) | N | E | Shockwave; needs and costs half your breath meter |
| Long press | Enter | Enter | Start, pause, resume, restart |

`I` toggles the debug overlay (per knob: raw `!s` values, noise floor, calibrated mic level, last
`hud`/`hap`), `F` toggles full screen. Keyboard and knobs work at the same time.

The shield only absorbs sparks of its own polarity; the others fly straight through and must be
shot or blown away. The game asks for a moment of silence at every start while it measures the
room's noise floor, per microphone. The clap key does nothing while the noise key is held, exactly
as a clap is not heard while somebody is blowing.

## Files

| File | Role |
|---|---|
| `index.html`, `style.css` | Page, panels and all on-screen text outside the canvas |
| `src/config.js` | **Every tuning constant** |
| `src/game.js` | Game rules for one or two players, pure: `step(state, events, dt) -> { state, effects }` |
| `src/mic.js` | Microphone calibration, pure: noise floor, 0..1 level, clap detection (one state per knob) |
| `src/protocol.js` | Wire contract, pure: parse `!s`/`!hello`, counter differences, `hud`/`hap`, rate limits, line splitting |
| `src/serial.js` | Web Serial shell: one `SerialLink` per knob, read loop, `hello` retry, unplug and return to the same slot |
| `src/ble.js` | Web Bluetooth shell with the same interface: one `BleLink` per knob, Nordic UART Service, `hello` retry, reconnect with backoff |
| `src/outbox.js` | What may wait behind a slow Bluetooth link, pure: 20-byte pieces, newest `hud` only, late `hap` skipped |
| `src/knoblink.js` | One player's knob over either transport, pure: which link is active, switching between them |
| `src/render.js` | Canvas renderer and decoration (particles, rings, shake, player badges and pulses) |
| `src/keyboard.js` | Keyboard stand-in for both knobs |
| `src/main.js` | Wiring (one slot per player), DOM updates, Danish texts, debug overlay |
| `test/*.test.js` | `node --test` suites for the pure modules, and for `BleLink` against a fake `navigator.bluetooth` |

## Tuning

Everything is in `src/config.js`, grouped:

- `CONTROL.DETENT_DEG` – degrees per knob detent (12 assumes 30 detents per revolution; set it to
  360 / the real count).
- `MIC` – `MARGIN_CDB` (how far above the noise floor silence ends), `SPAN_CDB` (how far above it
  full strength is), `CLAP_MIN_LEVEL` / `CLAP_PREV_MAX` (what counts as a clap), floor tracking
  speeds, `CALIBRATION_MS`. Watch the debug overlay (I) while adjusting.
- `RULES` – difficulty curve (`RAMP_S`, spawn interval, spark speed), damage, scoring, bolt
  cooldown, breath drain/refill, push strength, shockwave cost and radius.
  `TWO_PLAYER_INTERVAL_FACTOR` sets how much denser the sparks are with two players.
- `ARENA.SHIELD_RADII` – the orbit radius of each player's shield.
- `WAVEFORM` and `HAPTIC_CUES` – DRV2605L waveform numbers and which game event plays which
  (effect 0 = no cue).
- `LINK` – USB vendor id, `hud`/`hap` pacing, `hello` retry, plausibility limits for counter jumps.
- `BLE` – service and characteristic UUIDs, bytes per write (`CHUNK_BYTES`), write with or without
  response, how long a `hap` may wait behind other writes (`HAP_MAX_WAIT_MS`), reconnect backoff
  (`RECONNECT_BACKOFF_MS`), connect and write timeouts.
- `KEYBOARD_MIC` – the keyboard's simulated microphone.

Colours are in `PALETTE` at the top of `src/render.js` and in `:root` in `style.css`;
`JOIN_PULSE_S` (how long a shield pulses for a new player) is next to `PALETTE`.

## Known limits

- Web Serial does not expose a USB serial number, so two knobs cannot be told apart by anything
  but the port object Chrome hands out. One knob unplugged and replugged always returns to its
  slot. If both are unplugged at once, each returns to its own slot when Chrome reuses the port
  object; if Chrome creates new objects, the first one plugged back in becomes player 1.
- Chrome's port list shows both knobs under the same name. If player 2 picks the knob that is
  already player 1, the page says so and nothing changes.
- The page cannot tell that a cable and a Bluetooth link lead to the same knob. If one knob is
  given to player 1 by cable and to player 2 by Bluetooth, both shields follow it.
- The Bluetooth link has only been tested against a fake `navigator.bluetooth` in `node --test`,
  not yet against a real knob in a real browser.
