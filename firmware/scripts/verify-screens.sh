#!/usr/bin/env bash
# Walk the Ekko controller through its screens and inputs over the serial test console
# (components/testctl) and record what the device shows: the LVGL framebuffer (snap) and, if a
# camera script is given, the webcam. One directory of evidence per run; exits 1 on a model
# mismatch. Extend the list when you add a screen or an input.
#   KNOB_PORT=/dev/cu.usbmodem1101 scripts/verify-screens.sh [out_dir]
#   KNOB_CAM=/path/to/verify-with-webcam/scripts/capture.sh # optional webcam capture per step
# The expected strings are what app_state_line() prints. `hud ...` is the protocol line the
# browser sends (PROTOCOL.md); testctl.py sends it and then asks for the state. A hud is only
# valid for 3 s, so each screen step sends its own.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/build/verify}"
TC="$ROOT/scripts/testctl.py"
CAM="${KNOB_CAM:-}"
PY="${KNOB_PYTHON:-python3}"
mkdir -p "$OUT"
fail=0

check() {  # check <name> <command...> ; EXPECT holds the expected reply substring
  local name="$1"; shift
  local reply; reply="$("$PY" "$TC" "$@")" || { echo "FAIL $name: $reply"; fail=1; return; }
  if [[ "$reply" != *"$EXPECT"* ]]; then echo "FAIL $name: got '$reply', want '$EXPECT'"; fail=1; else echo "ok   $name: $reply"; fi
}

check_re() {  # check_re <name> <extended regex> <command...> ; for replies that differ per device
  local name="$1" re="$2"; shift 2
  local reply; reply="$("$PY" "$TC" "$@")" || { echo "FAIL $name: $reply"; fail=1; return; }
  if [[ "$reply" =~ $re ]]; then echo "ok   $name: ${BASH_REMATCH[0]}"; else echo "FAIL $name: got '$reply', want /$re/"; fail=1; fi
}

step() {   # check, then record the screen
  local name="$1"
  check "$@"
  "$PY" "$TC" snap "$OUT/$name.png" >/dev/null || { echo "FAIL $name: no snapshot"; fail=1; }
  if [ -n "$CAM" ] && [ -x "$CAM" ]; then "$CAM" "$OUT/$name.cam.jpg" >/dev/null; fi
}

"$PY" "$TC" ping >/dev/null || { echo "device not answering on the test console"; exit 1; }

# The handshake over USB, answered on USB.
EXPECT="!hello ekko 1"                                   check 00-hello         hello

# Boot state: nothing counted, no browser -> the "Ikke forbundet" screen. Its title is the name
# the knob advertises over Bluetooth, Ekko- plus the last two bytes of its address, so the
# snapshot 00-offline.png must show the same name as this line. "ble=-" means the radio did not
# start (the boot log says why).
EXPECT="link=0 k=0 t=0 z=0 h=0"                          step 00-offline        reset
check_re 00-ble-name 'ble=Ekko-[0-9A-F]{4}$' state

# One composed screen per phase, each from its own hud line.
EXPECT="link=1 k=0 t=0 z=0 h=0 score=0 health=100 breath=0 phase=0 pol=0"       step 01-ready         hud 0 100 0 0 0
EXPECT="score=1250 health=80 breath=35 phase=1 pol=1"    step 02-playing        hud 1250 80 35 1 1
EXPECT="score=1300 health=45 breath=80 phase=1 pol=0"    step 03-playing-amber  hud 1300 45 80 1 0     # ring: caution
EXPECT="score=999999 health=10 breath=100 phase=1 pol=1" step 04-playing-max    hud 999999 10 100 1 1  # widest score, ring: alarm
EXPECT="score=1300 health=45 breath=80 phase=2 pol=0"    step 05-paused         hud 1300 45 80 2 0
EXPECT="score=48210 health=0 breath=0 phase=3 pol=0"     step 06-game-over      hud 48210 0 0 3 0

# Inputs: every injected event moves its own absolute counter and nothing else.
EXPECT="k=3 t=0 z=0 h=0"                                 check 07-knob-cw       knob +3
EXPECT="k=-4 t=0 z=0 h=0"                                check 08-knob-ccw      knob -7
EXPECT="k=-4 t=1 z=0 h=0"                                check 09-tap           tap
EXPECT="k=-4 t=1 z=1 h=0"                                check 10-zone          zone
EXPECT="k=-4 t=1 z=1 h=1"                                check 11-hold          hold
# The aim marker follows the knob without the browser: 12 degrees a detent, so 15 detents is
# half a turn and the marker sits at 6 o'clock.
EXPECT="k=15 t=1 z=1 h=1"                                check 12-knob-half     knob +19
EXPECT="link=1 k=15 t=1 z=1 h=1 score=77"                step 13-aim-marker     hud 77 100 50 1 1

# Lines the contract rejects change nothing and are counted, not answered.
EXPECT="score=77 health=100 breath=50 phase=1 pol=1 bad=1" check 14-bad-range   hud 77 101 50 1 1
EXPECT="score=77 health=100 breath=50 phase=1 pol=1 bad=2" check 15-bad-count   hud 77 100 50 1
EXPECT="bad=3"                                           check 16-bad-effect    hap 0
EXPECT="bad=3"                                           check 17-good-effect   hap 1

# 3 s without a hud -> back to the offline screen; the counters stay.
sleep 3.2
EXPECT="link=0 k=15 t=1 z=1 h=1"                         step 18-link-lost      state

echo; echo "evidence in $OUT"; ls "$OUT"
[ "$fail" -eq 0 ] && echo "ALL SCREEN CHECKS PASSED" || { echo "SCREEN CHECKS FAILED"; exit 1; }
