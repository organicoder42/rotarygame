# Ekko

A small arcade game played in Chrome, with a Guition JC3636K518C round knob display (ESP32-S3)
as the controller. The knob talks to the browser over USB with the Web Serial API.

| On the knob | In the game |
|---|---|
| Turn | Move the shield around the core |
| Tap the screen | Fire a bolt along the shield's direction |
| Tap the small circle | Flip the shield's polarity |
| Blow or shout | Push the sparks away while breath lasts |
| Clap | Shockwave |
| Long press | Start, pause, restart |

The knob's own display shows score, health (ring colour), breath and polarity, and its haptic
motor plays the hits.

## Layout

- `PROTOCOL.md`: the wire contract both halves implement. Change it first, then both sides.
- `firmware/`: ESP-IDF 5.3 + LVGL 9 firmware for the knob. See `firmware/README.md`.
- `web/`: the game, plain static files with no build step. See `web/README.md`.

## Run

```bash
cd web && python3 -m http.server 8765     # then open http://localhost:8765 in Chrome
```

The game is fully playable from the keyboard without the knob.

## Credits

The firmware started from the `knob-starter` template and the `sounddetector` microphone
component of [ida-embedded-workshop](https://github.com/dalager/ida-embedded-workshop) by
Christian Dalager, MIT licensed. The licence text is in `firmware/LICENSE`. Font licences are in
`firmware/design/fonts/`.
