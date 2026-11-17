# Ekko — wire contract between the knob and the browser

One contract, two targets: `firmware/` (ESP-IDF, the JC3636K518C knob) and `web/` (the game in
Chrome). Both sides implement exactly this. Change this file first, then both sides.

## Transport

- USB Serial/JTAG of the ESP32-S3 (`303a:1001`), opened by the browser with the Web Serial API.
  115200 baud is passed for form's sake; USB CDC ignores it.
- ASCII lines terminated by `\n`. The receiver must tolerate `\r\n`.
- The same port carries the ESP-IDF log and the dev test console (`> ...` replies). **Any line
  that does not start with `!` is not protocol and must be ignored by the browser.**
- Bytes can be lost on this link (seen on macOS). Every device → host value is therefore
  **absolute**, never a delta: a lost line heals itself with the next one.

## Device → host

### `!s <k> <t> <z> <h> <m>` — input state

Sent immediately when `k`, `t`, `z` or `h` changes, and at least every 40 ms otherwise.

| Field | Type | Meaning |
|---|---|---|
| `k` | signed int | Knob position in detents since boot. Clockwise = +1 per detent. Not wrapped. |
| `t` | unsigned int | Number of short taps on the screen since boot. |
| `z` | unsigned int | Number of short taps on the small circle at the bottom since boot. |
| `h` | unsigned int | Number of long presses on the screen since boot. |
| `m` | signed int | Microphone level in centi-dBFS, DC removed: the **loudest** 10 ms block since the previous `!s` line. About `-7500` in a quiet room, towards `0` for loud. `-12000` = digital silence or no mic. |

The host acts on differences: `k` now minus `k` before = detents to turn; a counter that grew by
n = n events. A counter that went **down** means the device rebooted: resynchronise without
firing events.

Example: `!s -3 2 0 1 -6840`

### `!hello ekko 1` — handshake reply

Sent in answer to `hello`. The trailing number is the protocol version.

## Host → device

No reply is sent for `hud` and `hap` (keeps the link quiet). Unknown commands are ignored.

### `hello`

Device answers `!hello ekko 1` and sends a `!s` line.

### `hud <score> <health> <breath> <phase> <pol>` — what the knob's own display shows

| Field | Range | Meaning |
|---|---|---|
| `score` | 0..999999 | Shown large in the centre. |
| `health` | 0..100 | Core health. Drives the ring colour through the theme: high = idle colour, medium = caution colour, low = alarm colour. |
| `breath` | 0..100 | Breath meter, shown as the arc inside the ring. |
| `phase` | 0..3 | 0 = ready, 1 = playing, 2 = paused, 3 = game over. |
| `pol` | 0..1 | Shield polarity. 1 = the small circle is filled, 0 = outline only. |

Sent by the host on change, at most 10 times a second, and at least once a second while
connected (heartbeat). If the device has seen no `hud` for 3 s it shows its "not connected"
screen.

Example: `hud 1250 80 35 1 1`

### `hap <effect>` — play one haptic effect

`effect` is a DRV2605L library waveform number 1..123. The device drops effects that arrive
closer than 60 ms apart (the motor cannot render them, and the I2C bus is shared with touch).

## Dev test console (unchanged, for verification without a browser)

`ping`, `state`, `snap`, `knob <±N>`, `tap`, `zone`, `hold`, `reset` keep working and reply with
`> ...`. Injected inputs go through the same handlers as hardware input, so they also move the
counters in `!s`.
