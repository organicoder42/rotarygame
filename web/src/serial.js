// Web Serial shell: owns the port, turns bytes into protocol lines and keeps
// the `hello` handshake going. All protocol knowledge lives in protocol.js.
//
// States reported through onStatus({ state, detail }):
//   unsupported  the browser has no Web Serial
//   idle         nothing connected yet
//   connecting   the port is being opened
//   handshake    port open, waiting for `!hello ekko 1`
//   ready        the knob answered
//   lost         the cable was pulled or the device went away
//   error        the port could not be opened (detail: 'busy' | 'open-failed')
// detail 'version' on `ready` means the device speaks another protocol version.

import { LINK } from './config.js';
import { LineSplitter, formatHello, parseLine } from './protocol.js';

export class SerialLink {
  #port = null;
  #reader = null;
  #readDone = null;
  #writer = null;
  #closing = false;
  #helloTimer = null;
  #gotHello = false;
  /** False after the user pressed "disconnect": the port stays free (for
   *  flashing, a serial monitor ...) until they connect again themselves. */
  #autoReconnect = true;
  #state = 'idle';
  #encoder = new TextEncoder();

  /**
   * @param {object} handlers
   * @param {(line: string) => void} handlers.onLine    every line starting with `!`
   * @param {(status: {state: string, detail?: string}) => void} handlers.onStatus
   * @param {(line: string) => void} [handlers.onIgnored] every other line (debug)
   */
  constructor({ onLine, onStatus, onIgnored }) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.onIgnored = onIgnored;
    this.supported = typeof navigator !== 'undefined' && 'serial' in navigator;

    if (!this.supported) {
      this.#state = 'unsupported';
      return;
    }
    navigator.serial.addEventListener('disconnect', (event) => {
      if (event.target === this.#port) this.#teardown('lost');
    });
    // A port the user already granted comes back: reopen it without a click.
    navigator.serial.addEventListener('connect', (event) => {
      if (!this.#port && this.#autoReconnect && this.#matches(event.target)) this.#open(event.target);
    });
  }

  get state() {
    return this.#state;
  }

  /** True while lines can be sent. */
  get isOpen() {
    return this.#writer !== null;
  }

  /** Ask the user for the knob. Must be called from a user gesture. */
  async connect() {
    if (!this.supported || this.#port) return;
    this.#autoReconnect = true;
    let port;
    try {
      port = await navigator.serial.requestPort({ filters: [{ usbVendorId: LINK.USB_VENDOR_ID }] });
    } catch {
      return; // the user closed the chooser
    }
    await this.#open(port);
  }

  /** Reopen a port granted on an earlier visit, if exactly one is plugged in. */
  async reconnectKnown() {
    if (!this.supported || this.#port) return;
    try {
      const ports = (await navigator.serial.getPorts()).filter((p) => this.#matches(p));
      if (ports.length === 1) await this.#open(ports[0]);
    } catch {
      // nothing granted yet
    }
  }

  /** Sends one line. Returns false when it could not be queued. */
  send(line) {
    const writer = this.#writer;
    if (!writer || typeof line !== 'string') return false;
    // If the device stopped reading, drop instead of piling up stale lines.
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return false;
    writer.write(this.#encoder.encode(`${line}\n`)).catch(() => {});
    return true;
  }

  /** Closes the port and leaves it alone until connect() is called again. */
  async disconnect() {
    this.#autoReconnect = false;
    await this.#teardown('idle');
  }

  #matches(port) {
    try {
      return port.getInfo().usbVendorId === LINK.USB_VENDOR_ID;
    } catch {
      return false;
    }
  }

  #setState(state, detail) {
    this.#state = state;
    this.onStatus({ state, detail });
  }

  async #open(port) {
    if (this.#port) return;
    this.#port = port;
    this.#closing = false;
    this.#gotHello = false;
    this.#setState('connecting');
    try {
      // The larger buffer keeps `send` from seeing a full queue unless the
      // device has really stopped reading.
      await port.open({ baudRate: LINK.BAUD_RATE, bufferSize: 4096 });
    } catch (err) {
      this.#port = null;
      // Chrome reports a port held by another program as a NetworkError.
      this.#setState('error', err && err.name === 'NetworkError' ? 'busy' : 'open-failed');
      return;
    }
    if (this.#port !== port) return; // torn down while opening
    try {
      this.#writer = port.writable.getWriter();
    } catch {
      await this.#teardown('error', 'open-failed');
      return;
    }
    this.#setState('handshake');
    this.#readDone = this.#readLoop(port);

    // Bytes can get lost and the device may still be booting: keep asking
    // until it answers.
    this.send(formatHello());
    this.#helloTimer = setInterval(() => {
      if (this.#gotHello) {
        clearInterval(this.#helloTimer);
        this.#helloTimer = null;
      } else {
        this.send(formatHello());
      }
    }, LINK.HELLO_RETRY_MS);
  }

  async #readLoop(port) {
    const splitter = new LineSplitter();
    const decoder = new TextDecoder();
    // A non-fatal read error (overrun, framing) leaves port.readable usable;
    // a fatal one (unplug) sets it to null.
    while (this.#port === port && !this.#closing && port.readable) {
      const reader = port.readable.getReader();
      this.#reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.#feed(splitter.push(decoder.decode(value, { stream: true })));
        }
      } catch {
        splitter.reset();
      } finally {
        this.#reader = null;
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
      if (this.#closing) break;
    }
    if (this.#port === port && !this.#closing) this.#teardown('lost');
  }

  #feed(lines) {
    for (const line of lines) {
      if (!line.startsWith('!')) {
        if (this.onIgnored) this.onIgnored(line);
        continue;
      }
      const msg = parseLine(line);
      if (msg && msg.type === 'hello' && !this.#gotHello) {
        this.#gotHello = true;
        const ok = msg.name === LINK.DEVICE_NAME && msg.version === LINK.PROTOCOL_VERSION;
        this.#setState('ready', ok ? undefined : 'version');
      }
      this.onLine(line);
    }
  }

  async #teardown(state, detail) {
    const port = this.#port;
    if (!port) {
      if (this.#state !== state) this.#setState(state, detail);
      return;
    }
    this.#closing = true;
    this.#port = null;
    if (this.#helloTimer) {
      clearInterval(this.#helloTimer);
      this.#helloTimer = null;
    }
    const reader = this.#reader;
    const readDone = this.#readDone;
    const writer = this.#writer;
    this.#writer = null;
    this.#readDone = null;
    this.#setState(state, detail);
    try {
      if (reader) await reader.cancel();
    } catch {
      // the device is already gone
    }
    // The read loop must have released its lock before the port can close.
    if (readDone) await readDone;
    try {
      if (writer) {
        await writer.abort();
        writer.releaseLock();
      }
    } catch {
      // the device is already gone
    }
    try {
      await port.close();
    } catch {
      // the device is already gone
    }
  }
}
