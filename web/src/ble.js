// Web Bluetooth shell: the same interface as SerialLink (serial.js), with the
// Nordic UART Service as the pipe. It owns the device, turns notifications
// into protocol lines, writes commands in pieces of at most 20 bytes and keeps
// the `hello` handshake going. What may wait behind a slow link is decided in
// outbox.js; the protocol itself lives in protocol.js.
//
// States reported through onStatus({ state, detail }):
//   unsupported  the browser has no Web Bluetooth
//   idle         no knob chosen
//   connecting   a knob was chosen and is being connected
//                (detail 'retry': it has not answered yet, trying again)
//   handshake    connected and subscribed, waiting for `!hello ekko 1`
//   ready        the knob answered (detail 'version': other protocol version)
//   lost         the link dropped; reconnecting by itself with backoff
//   error        detail 'taken': the knob already belongs to the other player
//                detail 'unavailable': the computer has no usable Bluetooth
//
// The browser's permission for a BLE device does not survive a page reload,
// so there is nothing to reopen at start: the player picks the knob again.

import { BLE, LINK } from './config.js';
import { WriteQueue } from './outbox.js';
import { LineSplitter, formatHello, parseLine } from './protocol.js';

const STALE = new Error('stale attempt');
const TIMEOUT = new Error('timeout');

const realClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** How long to wait before the next attempt after `failures` failed ones. */
export function reconnectDelay(failures, steps = BLE.RECONNECT_BACKOFF_MS) {
  const index = Math.min(Math.max(0, Math.trunc(failures) || 0), steps.length - 1);
  return steps[index];
}

// One link per player. A link keeps its device object for as long as the
// player has not let go of it, also while the link is down: that is what
// brings a knob back to the slot it had, and what keeps the other player
// from picking it in the meantime (device.id is stable within a page).
export class BleLink {
  /** Every link on the page. */
  static #links = [];

  #bluetooth;
  #clock;
  #device = null;
  /** Bumped whenever an attempt starts or ends, to recognise late results. */
  #epoch = 0;
  /** The value of #epoch while an attempt is running, otherwise -1. */
  #attemptEpoch = -1;
  /** The open pipe: { rx, tx, onValue, pumping, failures }, or null. */
  #session = null;
  /** True once this device has been connected, so a drop reads as "lost". */
  #everUp = false;
  /** Failed attempts since the knob last answered `hello`. */
  #failures = 0;
  #choosing = false;
  #retryTimer = null;
  #helloTimer = null;
  #gotHello = false;
  #state = 'idle';
  #detail = undefined;
  #queue = new WriteQueue();
  #splitter = new LineSplitter();
  #decoder = new TextDecoder();
  /** Times the link came back by itself. */
  reconnects = 0;

  #onGattDisconnected = (event) => {
    if (event.target !== this.#device) return;
    if (this.#session) this.#dropped();
    // Dropped half-way through an attempt: do not wait for its timeout.
    else if (this.#attemptEpoch === this.#epoch) this.#attemptFailed(this.#device);
  };

  /**
   * @param {object} handlers
   * @param {(line: string) => void} handlers.onLine    every line starting with `!`
   * @param {(status: {state: string, detail?: string}) => void} handlers.onStatus
   * @param {(line: string) => void} [handlers.onIgnored] every other line (debug)
   * @param {object} [handlers.bluetooth] stand-in for navigator.bluetooth (tests)
   * @param {object} [handlers.clock]     stand-in for now/setTimeout/clearTimeout (tests)
   */
  constructor({ onLine, onStatus, onIgnored, bluetooth, clock }) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.onIgnored = onIgnored;
    this.#clock = clock ?? realClock;
    this.#bluetooth = bluetooth ?? (typeof navigator !== 'undefined' ? navigator.bluetooth : null) ?? null;
    this.supported = !!this.#bluetooth && typeof this.#bluetooth.requestDevice === 'function';

    if (!this.supported) {
      this.#state = 'unsupported';
      return;
    }
    BleLink.#links.push(this);
  }

  get state() {
    return this.#state;
  }

  /** True while lines can be sent. */
  get isOpen() {
    return this.#session !== null;
  }

  /** The chosen knob's name (`Ekko-XXXX`), also while it is being reconnected. */
  get name() {
    return (this.#device && this.#device.name) || null;
  }

  /** The browser's id for the chosen knob, or null. */
  get deviceId() {
    return this.#device ? this.#device.id : null;
  }

  /** Write queue counters, for the debug overlay. */
  get stats() {
    return { ...this.#queue.stats, waiting: this.#queue.waiting, reconnects: this.reconnects };
  }

  /** Ask the user for the knob. Must be called from a user gesture. */
  async connect() {
    if (!this.supported || this.#choosing || this.#session || this.#state === 'connecting') return;
    this.#choosing = true;
    let device;
    try {
      device = await this.#bluetooth.requestDevice({ filters: [{ services: [BLE.SERVICE_UUID] }] });
    } catch (err) {
      // Closing the chooser is a NotFoundError and not worth a message; so is
      // a computer without a Bluetooth adapter, which is.
      if (err && (err.name !== 'NotFoundError' || /adapter/i.test(String(err.message)))) {
        this.#setState('error', 'unavailable');
      }
      return;
    } finally {
      this.#choosing = false;
    }
    // The chooser also lists the knob the other player is waiting for.
    if (BleLink.#links.some((l) => l !== this && l.#device && l.#device.id === device.id)) {
      this.#setState('error', 'taken');
      return;
    }
    this.#forget();
    this.#device = device;
    this.#everUp = false;
    this.#failures = 0;
    device.addEventListener('gattserverdisconnected', this.#onGattDisconnected);
    this.#setState('connecting');
    await this.#attempt();
  }

  /** Nothing to reopen: Bluetooth permissions do not outlive the page. */
  async reconnectKnown() {}

  /** Sends one line. Returns false when it could not be queued. */
  send(line) {
    const session = this.#session;
    if (!session || typeof line !== 'string') return false;
    const queued = this.#queue.offer(line, this.#clock.now());
    this.#pump(session);
    return queued;
  }

  /** Lets go of the knob and stops reconnecting until connect() is called again. */
  async disconnect() {
    this.#forget();
    if (this.supported && this.#state !== 'idle') this.#setState('idle');
  }

  #setState(state, detail) {
    this.#state = state;
    this.#detail = detail;
    this.onStatus({ state, detail });
  }

  /** One attempt to open the pipe to the chosen device. Never throws. */
  async #attempt() {
    const device = this.#device;
    if (!device) return;
    const epoch = ++this.#epoch;
    this.#attemptEpoch = epoch;
    const current = () => this.#epoch === epoch;
    let session;
    try {
      session = await this.#deadline(this.#open(device, current), BLE.CONNECT_TIMEOUT_MS);
    } catch {
      if (current()) this.#attemptFailed(device);
      return;
    }
    if (!current()) {
      session.tx.removeEventListener('characteristicvaluechanged', session.onValue);
      return;
    }
    this.#attemptEpoch = -1;
    if (this.#everUp) this.reconnects += 1;
    this.#everUp = true;
    this.#session = session;
    this.#gotHello = false;
    this.#queue.clear();
    this.#splitter.reset();
    this.#decoder = new TextDecoder();
    this.#setState('handshake');
    this.#hello(session);
  }

  async #open(device, current) {
    const check = () => {
      if (!current()) throw STALE;
    };
    const server = await device.gatt.connect();
    check();
    const service = await server.getPrimaryService(BLE.SERVICE_UUID);
    check();
    const rx = await service.getCharacteristic(BLE.RX_UUID);
    check();
    const tx = await service.getCharacteristic(BLE.TX_UUID);
    check();
    const onValue = (event) => {
      if (this.#session && this.#session.tx === tx) this.#receive(event.target.value);
    };
    // Listen before subscribing, so that no notification is missed.
    tx.addEventListener('characteristicvaluechanged', onValue);
    try {
      await tx.startNotifications();
      check();
    } catch (err) {
      tx.removeEventListener('characteristicvaluechanged', onValue);
      throw err;
    }
    return { rx, tx, onValue, pumping: false, failures: 0 };
  }

  #attemptFailed(device) {
    this.#epoch += 1;
    // Also gives up a connection that is half open or still pending.
    this.#gattDisconnect(device);
    this.#failures += 1;
    const state = this.#everUp ? 'lost' : 'connecting';
    const detail = this.#everUp ? undefined : 'retry';
    if (this.#state !== state || this.#detail !== detail) this.#setState(state, detail);
    this.#scheduleRetry();
  }

  /** The open link went away by itself. */
  #dropped() {
    const device = this.#device;
    this.#epoch += 1;
    // A link that drops before the knob has answered counts as a failure, so
    // that a knob that keeps falling off is not hammered.
    if (!this.#gotHello) this.#failures += 1;
    this.#closeSession();
    this.#clearTimers();
    this.#gattDisconnect(device);
    this.#setState('lost');
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      this.#attempt();
    }, reconnectDelay(this.#failures));
  }

  /** Bytes can get lost and the device may be busy: keep asking until it answers. */
  #hello(session) {
    if (this.#session !== session || this.#gotHello) return;
    this.send(formatHello());
    this.#helloTimer = this.#clock.setTimeout(() => this.#hello(session), LINK.HELLO_RETRY_MS);
  }

  #receive(view) {
    this.#feed(this.#splitter.push(this.#decoder.decode(view, { stream: true })));
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
        this.#failures = 0;
        const ok = msg.name === LINK.DEVICE_NAME && msg.version === LINK.PROTOCOL_VERSION;
        this.#setState('ready', ok ? undefined : 'version');
      }
      this.onLine(line);
    }
  }

  /** Writes what the queue hands out, one piece at a time. */
  async #pump(session) {
    if (session.pumping) return;
    session.pumping = true;
    try {
      while (this.#session === session) {
        const chunk = this.#queue.next(this.#clock.now());
        if (!chunk) break;
        let failure = null;
        try {
          await this.#deadline(this.#write(session.rx, chunk), BLE.WRITE_TIMEOUT_MS);
        } catch (err) {
          failure = err ?? new Error('write failed');
        }
        if (this.#session !== session) break; // the queue was cleared with the link
        if (!failure) {
          this.#queue.ack();
          session.failures = 0;
          continue;
        }
        this.#queue.fail();
        session.failures += 1;
        if (failure === TIMEOUT || session.failures >= BLE.MAX_WRITE_FAILURES) this.#dropped();
        // Do not spin on a link that refuses writes: the next send() tries again.
        break;
      }
    } finally {
      session.pumping = false;
    }
  }

  async #write(rx, chunk) {
    const canSkipResponse =
      typeof rx.writeValueWithoutResponse === 'function' && !(rx.properties && rx.properties.writeWithoutResponse === false);
    if (!BLE.WRITE_WITH_RESPONSE && canSkipResponse) return rx.writeValueWithoutResponse(chunk);
    if (typeof rx.writeValueWithResponse === 'function') return rx.writeValueWithResponse(chunk);
    return rx.writeValue(chunk);
  }

  /** Settles like `promise`, or rejects with TIMEOUT after `ms`. */
  #deadline(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this.#clock.setTimeout(() => reject(TIMEOUT), ms);
    });
    return Promise.race([promise, timeout]).finally(() => this.#clock.clearTimeout(timer));
  }

  #closeSession() {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    session.tx.removeEventListener('characteristicvaluechanged', session.onValue);
    this.#queue.clear();
    this.#splitter.reset();
  }

  #clearTimers() {
    this.#clock.clearTimeout(this.#retryTimer);
    this.#clock.clearTimeout(this.#helloTimer);
    this.#retryTimer = null;
    this.#helloTimer = null;
  }

  #gattDisconnect(device) {
    try {
      if (device && device.gatt) device.gatt.disconnect();
    } catch {
      // already gone
    }
  }

  /** Lets go of the device: no session, no timers, no further attempts. */
  #forget() {
    const device = this.#device;
    this.#epoch += 1;
    this.#closeSession();
    this.#clearTimers();
    if (!device) return;
    this.#device = null;
    device.removeEventListener('gattserverdisconnected', this.#onGattDisconnected);
    this.#gattDisconnect(device);
  }
}
