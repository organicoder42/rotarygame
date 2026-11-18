# Ekko — wire contract between the knob and the browser

One contract, two targets: `firmware/` (ESP-IDF, the JC3636K518C knob) and `web/` (the game in
Chrome). Both sides implement exactly this. Change this file first, then both sides.

## Transport

Two transports carry the same byte stream: ASCII lines terminated by `\n` (the receiver must
tolerate `\r\n`). Everything below "Device → host" is identical on both. The device runs both
at once; the host picks one per knob.

Every device → host value is **absolute**, never a delta: a lost line heals itself with the
next one. That holds on both transports.

### USB (cable)

- USB Serial/JTAG of the ESP32-S3 (`303a:1001`), opened by the browser with the Web Serial API.
  115200 baud is passed for form's sake; USB CDC ignores it.
- The same port carries the ESP-IDF log and the dev test console (`> ...` replies). **Any line
  that does not start with `!` is not protocol and must be ignored by the browser.**
- Bytes can be lost on this link (seen on macOS).

### Bluetooth LE (wireless)

The device is a BLE peripheral; the browser connects with the Web Bluetooth API. The knob still
needs power through its USB-C socket, but any charger and either plug orientation will do.

- GATT service: the Nordic UART Service, used as a plain byte pipe.

  | What | UUID | Properties |
  |---|---|---|
  | Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | |
  | RX, host → device | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | write, write without response |
  | TX, device → host | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | notify |

- **Framing is by `\n` only.** A notification or a write is not a message: a line may arrive
  split over several of them, and one may hold several lines. Both sides reassemble.
- The host must not assume an MTU above the default 23: it sends a command in pieces of at most
  20 bytes, in order, as writes without response; the device must take several such writes per
  connection interval. The device sends a line in one notification when it fits the negotiated
  MTU and splits it otherwise.
- The device ignores an empty line (the host may send a lone `\n` to close a fragment after a
  failed write), and it discards a partly received line when the central disconnects, so that a
  stale fragment cannot merge with the first line of the next connection.
- Over BLE the device sends **only** protocol lines (starting with `!`): no log, no test console
  replies. Lines received over BLE go through the same command handling as lines from USB.
- `!s` is sent only while a central has enabled notifications on TX, by the same rule as on USB
  (on change, and at least every 40 ms). A line the stack cannot take right now is dropped, never
  queued: an old `!s` is worth nothing.
- Advertising: connectable, whenever no central is connected. One central at a time. The
  advertising packet carries the flags and the 128-bit service UUID; the scan response carries
  the complete local name.
- Name: `Ekko-XXXX`, where `XXXX` is the last two bytes of the device's BLE address as four
  uppercase hex digits. The device shows this name on its "not connected" screen, so that two
  knobs can be told apart in the browser's device chooser.
- No pairing, no bonding, no encryption. Anyone in range can connect to a knob that is not
  already connected; that is accepted for a game controller.
- The device asks for a connection interval of 7.5–15 ms, latency 0, supervision timeout 2 s.
  The central decides.
- When the central disconnects, the device advertises again at once. Its counters keep counting
  (no reboot), so a host that reconnects continues from where it was.
- Both transports at once: commands are accepted from either, `!s` goes out on both, the 3 s
  `hud` timeout and the 60 ms `hap` rule do not care which transport a line came from.
- Host side: the browser's permission for a BLE device does not survive a page reload, so the
  player picks the knob again after a reload. Within a page the host reconnects by itself when
  the link drops.

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

## Several devices (two players)

Nothing on the wire changes. A second knob runs the same firmware and is a second, independent
link: its own port, its own handshake, its own counters.

- The host assigns player numbers in the order devices are connected, and a device that is
  unplugged and plugged in again returns to the slot it had.
- Each device gets its own `hud` line: that player's own `score`, `breath` and `pol`, and the
  shared `health` and `phase`. The heartbeat and rate limits apply per device.
- `hap` goes to the device of the player it concerns. A hit on the core and game over go to all.
- A device does not know its player number; the big screen shows which shield belongs to whom.
- Both microphones hear the same room. The host calibrates each one separately and does not try
  to tell the players' voices apart.

## Dev test console (unchanged, for verification without a browser)

`ping`, `state`, `snap`, `knob <±N>`, `tap`, `zone`, `hold`, `reset` keep working and reply with
`> ...`. Injected inputs go through the same handlers as hardware input, so they also move the
counters in `!s`.
