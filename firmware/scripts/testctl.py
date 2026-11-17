#!/usr/bin/env python3
"""Talk to the firmware's test console (components/testctl) over USB Serial/JTAG.

  scripts/testctl.py state                 -> prints "link=0 k=0 t=0 z=0 h=0 score=0 ..."
  scripts/testctl.py knob +3 | knob -1 | tap | zone | hold | reset | ping
  scripts/testctl.py hud 1250 80 35 1 1    -> sends the protocol line (which has no reply),
                                              then prints the state; same for `hap 14`
  scripts/testctl.py snap out.png          -> LVGL framebuffer as PNG (needs ffmpeg)

The port also carries the Ekko protocol (`!s ...` lines about 29 times a second) and the log;
only lines starting with "> " are console replies.

Exit code 0 on a "> ..." reply, 1 on timeout/error. Opens the port only for the call so the
camera capture and other readers can use it between calls."""
import base64, os, re, subprocess, sys, tempfile, time
try:
    import serial
except ImportError:
    sys.exit(f"pyserial is missing for this Python. Install it with:\n"
             f"  {sys.executable} -m pip install pyserial\n"
             "(pip-installed esptool brings it along; a pipx-installed esptool does not.)")

PORT = os.environ.get("KNOB_PORT", "/dev/ttyACM0")
ANSI = re.compile(r"\x1b\[[0-9;]*m")

def open_port():
    s = serial.Serial(PORT, 115200, timeout=0.2)
    s.reset_input_buffer()
    return s

def read_line(s, deadline):
    while time.time() < deadline:
        raw = s.readline()
        if raw:
            return ANSI.sub("", raw.decode(errors="replace")).rstrip("\r\n")
    return None

NO_REPLY = ("hello", "hud", "hap")   # protocol commands: the firmware answers none with "> "

def command(s, cmd, timeout=3.0):
    if cmd.split()[0] in NO_REPLY: cmd += "\nstate"
    s.write((cmd + "\n").encode()); s.flush()
    deadline = time.time() + timeout
    while True:
        line = read_line(s, deadline)
        if line is None: return None
        if line.startswith("> "): return line[2:]

SETTLE_S = float(os.environ.get("KNOB_SETTLE", "0.3"))   # let arc animations (160 ms) finish

def snap(s, out_png, timeout=30.0):
    time.sleep(SETTLE_S)
    s.reset_input_buffer()
    s.write(b"snap\n"); s.flush()
    deadline = time.time() + timeout
    w = h = None; rows = []
    while True:
        line = read_line(s, deadline)
        if line is None: return "timeout during snapshot"
        if line.startswith("> error"): return line[2:]
        if line.startswith("SNAP BEGIN"):
            _, _, w, h, _fmt = line.split(); w, h = int(w), int(h)
        elif line.startswith("S:"):
            try:
                row = base64.b64decode(line[2:].encode("ascii"), validate=True)
            except (ValueError, UnicodeEncodeError):
                return "corrupt row %d (log noise in the stream?)" % len(rows)
            if w and len(row) != w * 2: return "row %d has %d bytes, expected %d" % (len(rows), len(row), w * 2)
            rows.append(row)
        elif line.startswith("SNAP END"):
            break
    if len(rows) != h: return "got %d rows, expected %d" % (len(rows), h)
    raw = tempfile.NamedTemporaryFile(suffix=".raw", delete=False); raw.write(b"".join(rows)); raw.close()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb565le",
                    "-s", "%dx%d" % (w, h), "-i", raw.name, out_png], check=True)
    os.unlink(raw.name)
    return None

def main(argv):
    if len(argv) < 2: print(__doc__); return 2
    verb = argv[1]
    with open_port() as s:
        if verb == "snap":
            # The USB CDC stream occasionally drops bytes mid-dump (seen on macOS: two rows merged
            # into one). The frame is static, so drain what is left of the dump and ask again.
            for _attempt in range(3):
                err = snap(s, argv[2] if len(argv) > 2 else "snap.png")
                if not err: break
                while s.read(4096): pass
            if err: print("error:", err); return 1
            print(argv[2] if len(argv) > 2 else "snap.png"); return 0
        r = command(s, " ".join(argv[1:]))
        if r is None: print("error: no reply from", PORT); return 1
        print(r); return 0 if not r.startswith("error") else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv))
