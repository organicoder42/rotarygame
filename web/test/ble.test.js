// BleLink against a small fake of navigator.bluetooth and a hand-driven
// clock. This checks the link's own logic; it says nothing about how a real
// browser, operating system or knob behaves.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BleLink, reconnectDelay } from '../src/ble.js';
import { BLE, LINK } from '../src/config.js';

// ---------- fakes ----------

const named = (name, message = name) => Object.assign(new Error(message), { name });

/** Lets every pending promise callback run. */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

class FakeClock {
  t = 0;
  #timers = new Map();
  #nextId = 1;
  api = {
    now: () => this.t,
    setTimeout: (fn, ms) => {
      const id = this.#nextId++;
      this.#timers.set(id, { at: this.t + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      this.#timers.delete(id);
    },
  };

  get pending() {
    return this.#timers.size;
  }

  /** Moves time forward, running the timers that come due in order. */
  async advance(ms) {
    const end = this.t + ms;
    await flush();
    for (;;) {
      let due = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= end && (!due || timer.at < due.timer.at)) due = { id, timer };
      }
      if (!due) break;
      this.#timers.delete(due.id);
      this.t = due.timer.at;
      due.timer.fn();
      await flush();
    }
    this.t = end;
  }
}

class FakeCharacteristic extends EventTarget {
  writes = [];
  how = [];
  /** Writes started while another one was pending (Chrome rejects those). */
  overlaps = 0;
  /** true: a write stays pending until release() is called. */
  manual = false;
  /** This many of the next writes are rejected. */
  failNext = 0;
  notifying = false;
  value = null;
  #settle = null;

  constructor(device, uuid, properties) {
    super();
    this.device = device;
    this.uuid = uuid;
    this.properties = properties;
  }

  get busy() {
    return this.#settle !== null;
  }

  /** Everything written so far, as text. */
  get text() {
    return this.writes.map((bytes) => new TextDecoder().decode(bytes)).join('');
  }

  async startNotifications() {
    if (!this.device.gatt.connected) throw named('NetworkError', 'GATT Server is disconnected.');
    this.notifying = true;
    return this;
  }

  writeValueWithoutResponse(data) {
    return this.#write(data, 'without');
  }

  writeValueWithResponse(data) {
    return this.#write(data, 'with');
  }

  #write(data, how) {
    if (this.busy) {
      this.overlaps += 1;
      return Promise.reject(named('NetworkError', 'GATT operation already in progress.'));
    }
    if (!this.device.gatt.connected) return Promise.reject(named('NetworkError', 'GATT Server is disconnected.'));
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(named('NetworkError', 'GATT operation failed for unknown reason.'));
    }
    this.writes.push(Uint8Array.from(data));
    this.how.push(how);
    return new Promise((resolve, reject) => {
      this.#settle = (err) => {
        this.#settle = null;
        if (err) reject(err);
        else resolve();
      };
      if (!this.manual) queueMicrotask(() => this.#settle && this.#settle());
    });
  }

  /** Completes the pending write (manual mode). */
  release() {
    if (this.#settle) this.#settle();
  }

  abort() {
    if (this.#settle) this.#settle(named('NetworkError', 'GATT Server is disconnected.'));
  }

  /** The device sends these bytes in one notification. */
  notify(text) {
    const bytes = new TextEncoder().encode(text);
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

let nextDeviceId = 1;

class FakeDevice extends EventTarget {
  /** What the next connect() calls do: 'ok' (default), 'fail' or 'hang'. */
  plan = [];
  /** Clock time of every connect() call. */
  connectAt = [];
  rx = null;
  tx = null;
  manualWrites = false;
  writeWithoutResponse = true;
  hangDiscovery = false;
  #abortConnect = null;

  constructor(clock, name = 'Ekko-3F2A', id = `device-${nextDeviceId++}`) {
    super();
    this.clock = clock;
    this.id = id;
    this.name = name;
    const device = this;
    this.gatt = {
      device,
      connected: false,
      connect: () => device.#connect(),
      disconnect: () => device.#disconnect(),
      getPrimaryService: (uuid) => device.#service(uuid),
    };
  }

  #connect() {
    this.connectAt.push(this.clock.t);
    const step = this.plan.shift() ?? 'ok';
    if (step === 'fail') return Promise.reject(named('NetworkError', 'Connection attempt failed.'));
    if (step === 'hang') {
      return new Promise((_, reject) => {
        this.#abortConnect = () => reject(named('AbortError', 'Connection attempt aborted.'));
      });
    }
    this.gatt.connected = true;
    this.rx = new FakeCharacteristic(this, BLE.RX_UUID, { write: true, writeWithoutResponse: this.writeWithoutResponse });
    this.tx = new FakeCharacteristic(this, BLE.TX_UUID, { notify: true });
    this.rx.manual = this.manualWrites;
    return Promise.resolve(this.gatt);
  }

  #service(uuid) {
    if (!this.gatt.connected) return Promise.reject(named('NetworkError', 'GATT Server is disconnected.'));
    if (uuid !== BLE.SERVICE_UUID) return Promise.reject(named('NotFoundError', 'No such service.'));
    if (this.hangDiscovery) return new Promise(() => {});
    return Promise.resolve({
      getCharacteristic: async (id) => {
        if (id === BLE.RX_UUID) return this.rx;
        if (id === BLE.TX_UUID) return this.tx;
        throw named('NotFoundError', 'No such characteristic.');
      },
    });
  }

  #disconnect() {
    if (this.#abortConnect) {
      this.#abortConnect();
      this.#abortConnect = null;
    }
    if (!this.gatt.connected) return;
    this.gatt.connected = false;
    if (this.rx) this.rx.abort();
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }

  /** The radio link is lost (out of range, power pulled). */
  drop() {
    this.#disconnect();
  }
}

class FakeBluetooth {
  requests = [];
  /** The device the user picks next, or the error the chooser ends with. */
  pick = null;

  requestDevice(options) {
    this.requests.push(options);
    if (this.pick instanceof Error) return Promise.reject(this.pick);
    return Promise.resolve(this.pick);
  }
}

function makeLink(bluetooth, clock) {
  const statuses = [];
  const lines = [];
  const ignored = [];
  const link = new BleLink({
    bluetooth,
    clock: clock.api,
    onLine: (line) => lines.push(line),
    onStatus: ({ state, detail }) => statuses.push(detail ? `${state}:${detail}` : state),
    onIgnored: (line) => ignored.push(line),
  });
  return { link, statuses, lines, ignored };
}

/** A link that picked `device` and got as far as the fake allows. */
async function connected(options = {}) {
  const clock = options.clock ?? new FakeClock();
  const bluetooth = options.bluetooth ?? new FakeBluetooth();
  const device = options.device ?? new FakeDevice(clock);
  bluetooth.pick = device;
  const made = makeLink(bluetooth, clock);
  // Not awaited: connect() settles only when the first attempt has ended,
  // and an attempt that hangs needs the clock to move.
  made.link.connect();
  await flush();
  return { clock, bluetooth, device, ...made };
}

/** Connected, and the knob has answered `hello`. */
async function ready(options = {}) {
  const made = await connected(options);
  made.device.tx.notify('!hello ekko 1\n');
  await flush();
  return made;
}

// ---------- tests ----------

describe('reconnectDelay (backoff)', () => {
  it('follows the steps of the config and then repeats the last one', () => {
    const steps = BLE.RECONNECT_BACKOFF_MS;
    assert.ok(steps.length >= 2);
    steps.forEach((ms, i) => assert.equal(reconnectDelay(i), ms));
    assert.equal(reconnectDelay(steps.length), steps.at(-1));
    assert.equal(reconnectDelay(1000), steps.at(-1));
  });

  it('never gets shorter and tolerates nonsense', () => {
    const steps = BLE.RECONNECT_BACKOFF_MS;
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= steps[i - 1]);
    assert.equal(reconnectDelay(-3), steps[0]);
    assert.equal(reconnectDelay(NaN), steps[0]);
    assert.equal(reconnectDelay(2, [5, 6]), 6);
  });
});

describe('BleLink without Web Bluetooth', () => {
  it('reports unsupported and does nothing', async () => {
    const statuses = [];
    // Node has a navigator, but no navigator.bluetooth.
    const link = new BleLink({ onLine: () => {}, onStatus: (s) => statuses.push(s) });
    assert.equal(link.supported, false);
    assert.equal(link.state, 'unsupported');
    await link.connect();
    await link.reconnectKnown();
    await link.disconnect();
    assert.equal(link.send('hello'), false);
    assert.equal(link.isOpen, false);
    assert.equal(link.name, null);
    assert.equal(link.state, 'unsupported');
    assert.deepEqual(statuses, []);
  });
});

describe('BleLink: connecting', () => {
  it('asks for a device with the Nordic UART Service and nothing else', async () => {
    const { bluetooth } = await connected();
    assert.deepEqual(bluetooth.requests, [{ filters: [{ services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] }] }]);
  });

  it('subscribes to TX, sends hello and is up when the knob answers', async () => {
    const { link, device, statuses, lines } = await connected();
    assert.deepEqual(statuses, ['connecting', 'handshake']);
    assert.equal(device.tx.notifying, true);
    assert.equal(device.tx.uuid, '6e400003-b5a3-f393-e0a9-e50e24dcca9e');
    assert.equal(device.rx.uuid, '6e400002-b5a3-f393-e0a9-e50e24dcca9e');
    assert.equal(device.rx.text, 'hello\n');
    assert.equal(link.isOpen, true);
    assert.equal(link.name, 'Ekko-3F2A');
    assert.equal(link.deviceId, device.id);

    device.tx.notify('!hello ekko 1\n');
    assert.equal(link.state, 'ready');
    assert.deepEqual(statuses, ['connecting', 'handshake', 'ready']);
    assert.deepEqual(lines, ['!hello ekko 1']);
  });

  it('keeps asking hello until the knob answers, then stops', async () => {
    const { clock, device } = await connected();
    await clock.advance(LINK.HELLO_RETRY_MS * 3 + 10);
    assert.equal(device.rx.text, 'hello\n'.repeat(4));
    device.tx.notify('!hello ekko 1\n');
    await clock.advance(LINK.HELLO_RETRY_MS * 5);
    assert.equal(device.rx.text, 'hello\n'.repeat(4));
    assert.equal(clock.pending, 0, 'no timer left running');
  });

  it('says so when the knob speaks another protocol version', async () => {
    const { link, device, statuses } = await connected();
    device.tx.notify('!hello ekko 2\n');
    assert.equal(link.state, 'ready');
    assert.equal(statuses.at(-1), 'ready:version');
  });

  it('stays as it was when the user closes the chooser', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    bluetooth.pick = named('NotFoundError', 'User cancelled the requestDevice() chooser.');
    const { link, statuses } = makeLink(bluetooth, clock);
    await link.connect();
    assert.equal(link.state, 'idle');
    assert.deepEqual(statuses, []);
  });

  it('explains a computer without usable Bluetooth', async () => {
    for (const error of [named('NotFoundError', 'Bluetooth adapter not available.'), named('SecurityError')]) {
      const bluetooth = new FakeBluetooth();
      bluetooth.pick = error;
      const { link, statuses } = makeLink(bluetooth, new FakeClock());
      await link.connect();
      assert.deepEqual(statuses, ['error:unavailable'], error.message);
      assert.equal(link.isOpen, false);
    }
  });

  it('a second connect() while one is running does not open a second chooser', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    bluetooth.pick = new FakeDevice(clock);
    const { link } = makeLink(bluetooth, clock);
    const first = link.connect();
    const second = link.connect();
    await Promise.all([first, second]);
    await link.connect(); // and none when the link is already up
    assert.equal(bluetooth.requests.length, 1);
  });

  it('keeps trying when the chosen knob does not answer at first', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.plan = ['fail', 'fail'];
    const { link, statuses } = await connected({ clock, device });
    assert.deepEqual(statuses, ['connecting', 'connecting:retry']);
    assert.equal(link.isOpen, false);
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[1] + BLE.RECONNECT_BACKOFF_MS[2] + 10);
    assert.deepEqual(statuses, ['connecting', 'connecting:retry', 'handshake']);
    assert.equal(device.connectAt.length, 3);
    assert.equal(link.reconnects, 0, 'the first connection is not a reconnection');
  });

  it('gives up an attempt that hangs and tries again', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.plan = ['hang'];
    const { link, statuses } = await connected({ clock, device });
    assert.deepEqual(statuses, ['connecting']);
    await clock.advance(BLE.CONNECT_TIMEOUT_MS - 1);
    assert.equal(device.connectAt.length, 1);
    await clock.advance(1 + BLE.RECONNECT_BACKOFF_MS[1] + 10);
    assert.equal(device.connectAt.length, 2);
    assert.equal(link.state, 'handshake');
  });

  it('tries again when the service cannot be found in time', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.hangDiscovery = true;
    const { link } = await connected({ clock, device });
    assert.equal(link.state, 'connecting');
    device.hangDiscovery = false;
    await clock.advance(BLE.CONNECT_TIMEOUT_MS + BLE.RECONNECT_BACKOFF_MS[1] + 10);
    assert.equal(link.state, 'handshake');
    assert.equal(device.gatt.connected, true);
  });

  it('a drop in the middle of an attempt is retried without waiting for the timeout', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.hangDiscovery = true;
    const { link, statuses } = await connected({ clock, device });
    device.hangDiscovery = false;
    device.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[1] + 10);
    assert.equal(link.state, 'handshake');
    assert.deepEqual(statuses, ['connecting', 'connecting:retry', 'handshake']);
  });
});

describe('BleLink: receiving', () => {
  it('reassembles lines that arrive split over several notifications', async () => {
    const { device, lines } = await ready();
    lines.length = 0;
    device.tx.notify('!s -3 2');
    device.tx.notify(' 0 1 -68');
    assert.deepEqual(lines, []);
    device.tx.notify('40\n');
    assert.deepEqual(lines, ['!s -3 2 0 1 -6840']);
  });

  it('takes several lines from one notification, and the tail of the next', async () => {
    const { device, lines } = await ready();
    lines.length = 0;
    device.tx.notify('!s 1 0 0 0 -7500\n!s 2 0 0 0 -7400\n!s 3 0');
    assert.deepEqual(lines, ['!s 1 0 0 0 -7500', '!s 2 0 0 0 -7400']);
    device.tx.notify(' 0 0 -7300\n');
    assert.deepEqual(lines, ['!s 1 0 0 0 -7500', '!s 2 0 0 0 -7400', '!s 3 0 0 0 -7300']);
  });

  it('tolerates \\r\\n, also when it is split between two notifications', async () => {
    const { device, lines } = await ready();
    lines.length = 0;
    device.tx.notify('!s 1 0 0 0 -7500\r');
    device.tx.notify('\n!s 2 0 0 0 -7400\r\n');
    assert.deepEqual(lines, ['!s 1 0 0 0 -7500', '!s 2 0 0 0 -7400']);
  });

  it('hands lines that are not protocol to onIgnored only', async () => {
    const { device, lines, ignored } = await ready();
    lines.length = 0;
    device.tx.notify('I (12) main: hi\n> pong\n!s 1 0 0 0 -7500\n');
    assert.deepEqual(ignored, ['I (12) main: hi', '> pong']);
    assert.deepEqual(lines, ['!s 1 0 0 0 -7500']);
  });

  it('is ready when the hello answer comes in pieces behind a state line', async () => {
    const { link, device, lines } = await connected();
    device.tx.notify('!s 5 0 0 0 -7500\n!hel');
    assert.equal(link.state, 'handshake');
    device.tx.notify('lo ekko 1\n');
    assert.equal(link.state, 'ready');
    assert.deepEqual(lines, ['!s 5 0 0 0 -7500', '!hello ekko 1']);
  });
});

describe('BleLink: writing', () => {
  it('writes a long line in pieces of at most 20 bytes, in order', async () => {
    const { link, device } = await ready();
    device.rx.writes.length = 0;
    assert.equal(link.send('hud 999999 100 100 3 1'), true);
    await flush();
    assert.deepEqual(
      device.rx.writes.map((bytes) => new TextDecoder().decode(bytes)),
      ['hud 999999 100 100 3', ' 1\n'],
    );
    for (const bytes of device.rx.writes) assert.ok(bytes.length <= 20);
  });

  it('uses write without response when the characteristic offers it', async () => {
    const { link, device } = await ready();
    link.send('hap 14');
    await flush();
    assert.ok(device.rx.how.length >= 2);
    assert.ok(device.rx.how.every((how) => how === 'without'));
  });

  it('falls back to write with response when it does not', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.writeWithoutResponse = false;
    const { link } = await ready({ clock, device });
    link.send('hap 14');
    await flush();
    assert.equal(device.rx.text, 'hello\nhap 14\n');
    assert.ok(device.rx.how.every((how) => how === 'with'));
  });

  it('never starts a write while another one is pending', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.manualWrites = true;
    const { link } = await connected({ clock, device });
    // `hello` is pending. Everything else has to wait behind it.
    link.send('hud 999999 100 100 3 1');
    link.send('hap 14');
    await flush();
    assert.equal(device.rx.writes.length, 1);
    for (let i = 0; i < 10; i++) {
      device.rx.release();
      await flush();
    }
    assert.equal(device.rx.overlaps, 0);
    assert.equal(device.rx.text, 'hello\nhap 14\nhud 999999 100 100 3 1\n');
  });

  it('sends only the newest hud of those that piled up behind a slow write', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.manualWrites = true;
    const { link } = await connected({ clock, device });
    for (let score = 1; score <= 30; score++) assert.equal(link.send(`hud ${score} 100 100 1 1`), true);
    await flush();
    assert.equal(device.rx.text, 'hello\n');
    assert.equal(link.stats.waiting, 1);
    device.rx.release();
    await flush();
    device.rx.release();
    await flush();
    assert.equal(device.rx.text, 'hello\nhud 30 100 100 1 1\n');
    assert.equal(link.stats.replacedHud, 29);
  });

  it('skips a hap that waited too long behind a slow write', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.manualWrites = true;
    const { link } = await connected({ clock, device });
    device.tx.notify('!hello ekko 1\n');
    assert.equal(link.send('hap 14'), true);
    await clock.advance(BLE.HAP_MAX_WAIT_MS + 20);
    link.send('hud 7 100 100 1 1');
    for (let i = 0; i < 4; i++) {
      device.rx.release();
      await flush();
    }
    assert.equal(device.rx.text, 'hello\nhud 7 100 100 1 1\n');
    assert.equal(link.stats.expiredHap, 1);
  });

  it('plays a hap at once when the link is free', async () => {
    const { link, device } = await ready();
    device.rx.writes.length = 0;
    link.send('hap 14');
    await flush();
    assert.equal(device.rx.text, 'hap 14\n');
  });

  it('refuses to send while there is no link', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const { link } = makeLink(bluetooth, clock);
    assert.equal(link.send('hello'), false);
    assert.equal(link.send(42), false);
  });

  it('closes a line that was cut short before sending the next one', async () => {
    const { link, device } = await ready();
    device.rx.writes.length = 0;
    link.send('hud 999999 100 100 3 1');
    // The first piece is on its way; the second one will be refused.
    device.rx.failNext = 1;
    await flush();
    assert.equal(device.rx.text, 'hud 999999 100 100 3');
    link.send('hap 14');
    await flush();
    assert.equal(device.rx.text, 'hud 999999 100 100 3\nhap 14\n');
    assert.equal(link.state, 'ready', 'one failed write is not the end of the link');
  });

  it('treats a link that keeps refusing writes as lost', async () => {
    const { link, device, statuses } = await ready();
    device.rx.failNext = 1000;
    for (let i = 0; i < BLE.MAX_WRITE_FAILURES - 1; i++) {
      link.send(`hud ${i} 100 100 1 1`);
      await flush();
    }
    assert.equal(link.state, 'ready');
    link.send('hud 99 100 100 1 1');
    await flush();
    assert.equal(link.state, 'lost');
    assert.equal(statuses.at(-1), 'lost');
    assert.equal(device.gatt.connected, false);
  });

  it('treats a write that never completes as a lost link and reconnects', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    const { link } = await ready({ clock, device });
    device.rx.manual = true;
    link.send('hud 1 100 100 1 1');
    await clock.advance(BLE.WRITE_TIMEOUT_MS - 1);
    assert.equal(link.state, 'ready');
    device.manualWrites = false;
    await clock.advance(1 + BLE.RECONNECT_BACKOFF_MS[0] + 10);
    assert.equal(link.state, 'handshake');
    assert.equal(device.rx.text, 'hello\n', 'a fresh pipe: only the new hello');
  });
});

describe('BleLink: losing the link and getting it back', () => {
  it('reconnects by itself, sends hello again and is ready when the knob answers', async () => {
    const { clock, link, device, statuses, lines } = await ready();
    const oldRx = device.rx;
    device.drop();
    assert.equal(link.state, 'lost');
    assert.equal(link.isOpen, false);
    assert.equal(link.send('hud 1 100 100 1 1'), false);
    assert.equal(link.name, 'Ekko-3F2A', 'the name stays while the page is trying');

    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] - 1);
    assert.equal(device.connectAt.length, 1, 'waits for the backoff first');
    await clock.advance(2);
    assert.equal(device.connectAt.length, 2);
    assert.equal(link.state, 'handshake');
    assert.notEqual(device.rx, oldRx);
    assert.equal(device.rx.text, 'hello\n');
    assert.equal(device.tx.notifying, true);

    device.tx.notify('!hello ekko 1\n!s 9 4 1 0 -7000\n');
    assert.equal(link.state, 'ready');
    assert.deepEqual(statuses, ['connecting', 'handshake', 'ready', 'lost', 'handshake', 'ready']);
    assert.deepEqual(lines, ['!hello ekko 1', '!hello ekko 1', '!s 9 4 1 0 -7000']);
    assert.equal(link.reconnects, 1);
  });

  it('forgets a half-received line and whatever was waiting to be written', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    const { link, lines } = await ready({ clock, device });
    lines.length = 0;
    device.tx.notify('!s 1 0 0');
    device.rx.manual = true;
    link.send('hud 999999 100 100 3 1');
    link.send('hap 14');
    await flush();
    device.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    device.tx.notify('!s 2 0 0 0 -7500\n');
    assert.deepEqual(lines, ['!s 2 0 0 0 -7500'], 'not glued to the old fragment');
    assert.equal(device.rx.text, 'hello\n', 'the old hud and hap are not replayed');
  });

  it('ignores notifications from the old connection', async () => {
    const { clock, device, lines } = await ready();
    const oldTx = device.tx;
    device.drop();
    lines.length = 0;
    oldTx.notify('!s 1 0 0 0 -7500\n');
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    oldTx.notify('!s 2 0 0 0 -7500\n');
    assert.deepEqual(lines, []);
  });

  it('backs off between attempts and keeps trying for as long as it takes', async () => {
    const { clock, link, device, statuses } = await ready();
    const steps = BLE.RECONNECT_BACKOFF_MS;
    const tries = steps.length + 3;
    device.plan = Array(tries).fill('fail');
    const droppedAt = clock.t;
    device.connectAt.length = 0;
    device.drop();
    await clock.advance(steps.reduce((a, b) => a + b, 0) + 3 * steps.at(-1) + 10);

    const expected = [];
    let at = droppedAt;
    for (let i = 0; i < tries + 1; i++) {
      at += steps[Math.min(i, steps.length - 1)];
      expected.push(at);
    }
    assert.deepEqual(device.connectAt, expected.slice(0, device.connectAt.length));
    assert.equal(device.connectAt.length, tries);
    assert.equal(link.state, 'lost');
    assert.equal(statuses.filter((s) => s === 'lost').length, 1, 'lost is reported once, not per attempt');

    await clock.advance(steps.at(-1));
    assert.equal(link.state, 'handshake', 'and it comes back when the knob does');
  });

  it('starts again with a short wait once the knob has answered', async () => {
    const { clock, link, device } = await ready();
    device.plan = ['fail', 'fail', 'fail'];
    device.drop();
    await clock.advance(60_000);
    assert.equal(link.state, 'handshake');
    device.tx.notify('!hello ekko 1\n');
    device.connectAt.length = 0;
    const droppedAt = clock.t;
    device.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 1);
    assert.deepEqual(device.connectAt, [droppedAt + BLE.RECONNECT_BACKOFF_MS[0]]);
  });

  it('waits longer each time when the link keeps dropping before the knob answers', async () => {
    const { clock, device } = await ready();
    const steps = BLE.RECONNECT_BACKOFF_MS;
    device.connectAt.length = 0;
    let droppedAt = clock.t;
    const waits = [];
    for (let i = 0; i < 3; i++) {
      device.drop();
      droppedAt = clock.t;
      await clock.advance(steps.at(-1) + 10);
      waits.push(device.connectAt.at(-1) - droppedAt);
    }
    assert.deepEqual(waits, [steps[0], steps[1], steps[2]]);
  });

  it('disconnect() lets go of the knob and stops reconnecting', async () => {
    const { clock, link, device, statuses } = await ready();
    await link.disconnect();
    assert.equal(link.state, 'idle');
    assert.equal(link.isOpen, false);
    assert.equal(link.name, null);
    assert.equal(device.gatt.connected, false);
    assert.equal(statuses.at(-1), 'idle');
    assert.ok(!statuses.includes('lost'), 'the user did this, the link was not lost');
    await clock.advance(60_000);
    assert.equal(device.connectAt.length, 1);
    assert.equal(clock.pending, 0);
  });

  it('disconnect() while reconnecting stops the attempts', async () => {
    const { clock, link, device } = await ready();
    device.plan = Array(50).fill('fail');
    device.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    const attempts = device.connectAt.length;
    await link.disconnect();
    await clock.advance(60_000);
    assert.equal(device.connectAt.length, attempts);
    assert.equal(link.state, 'idle');
  });

  it('disconnect() while an attempt hangs aborts it for good', async () => {
    const clock = new FakeClock();
    const device = new FakeDevice(clock);
    device.plan = ['hang'];
    const { link, statuses } = await connected({ clock, device });
    await link.disconnect();
    await clock.advance(60_000);
    assert.equal(device.connectAt.length, 1);
    assert.deepEqual(statuses, ['connecting', 'idle']);
  });

  it('can pick a knob again after letting go', async () => {
    const { clock, bluetooth, link, device } = await ready();
    await link.disconnect();
    const other = new FakeDevice(clock, 'Ekko-00B1');
    bluetooth.pick = other;
    await link.connect();
    other.tx.notify('!hello ekko 1\n');
    assert.equal(link.state, 'ready');
    assert.equal(link.name, 'Ekko-00B1');
    device.drop(); // the old knob is no longer ours
    assert.equal(link.state, 'ready');
  });

  it('has nothing to reopen after a page reload', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const { link, statuses } = makeLink(bluetooth, clock);
    await link.reconnectKnown();
    assert.equal(link.state, 'idle');
    assert.deepEqual(statuses, []);
    assert.deepEqual(bluetooth.requests, []);
  });
});

describe('BleLink: two players', () => {
  /** Two links on one page, each with its own knob, both ready. */
  async function twoPlayers() {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const knobA = new FakeDevice(clock, 'Ekko-3F2A');
    const knobB = new FakeDevice(clock, 'Ekko-00B1');
    const one = await ready({ clock, bluetooth, device: knobA });
    const two = await ready({ clock, bluetooth, device: knobB });
    return { clock, bluetooth, knobA, knobB, one, two };
  }

  it('each player has their own knob, name and lines', async () => {
    const { knobA, knobB, one, two } = await twoPlayers();
    assert.equal(one.link.name, 'Ekko-3F2A');
    assert.equal(two.link.name, 'Ekko-00B1');
    one.lines.length = 0;
    two.lines.length = 0;
    knobA.tx.notify('!s 1 0 0 0 -7500\n');
    knobB.tx.notify('!s 2 0 0 0 -7400\n');
    assert.deepEqual(one.lines, ['!s 1 0 0 0 -7500']);
    assert.deepEqual(two.lines, ['!s 2 0 0 0 -7400']);
    one.link.send('hap 14');
    await flush();
    assert.equal(knobA.rx.text, 'hello\nhap 14\n');
    assert.equal(knobB.rx.text, 'hello\n');
  });

  it('the knob of one player cannot be taken by the other', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const knob = new FakeDevice(clock);
    const one = await ready({ clock, bluetooth, device: knob });
    const two = makeLink(bluetooth, clock);
    await two.link.connect();
    assert.deepEqual(two.statuses, ['error:taken']);
    assert.equal(two.link.isOpen, false);
    assert.equal(two.link.name, null);
    assert.equal(one.link.state, 'ready', 'player 1 is not disturbed');
    assert.equal(knob.connectAt.length, 1);
  });

  it('compares device.id, not the object the chooser returned', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    await ready({ clock, bluetooth, device: new FakeDevice(clock, 'Ekko-3F2A', 'same-knob') });
    const twin = new FakeDevice(clock, 'Ekko-3F2A', 'same-knob');
    bluetooth.pick = twin;
    const two = makeLink(bluetooth, clock);
    await two.link.connect();
    assert.deepEqual(two.statuses, ['error:taken']);
    assert.equal(twin.connectAt.length, 0);
  });

  it('a knob that dropped still belongs to its player while the page waits for it', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const knob = new FakeDevice(clock);
    const one = await ready({ clock, bluetooth, device: knob });
    knob.plan = ['hang'];
    knob.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    assert.equal(one.link.state, 'lost');
    const two = makeLink(bluetooth, clock);
    await two.link.connect();
    assert.deepEqual(two.statuses, ['error:taken']);
  });

  it('a knob comes back to the slot it had, and the other player notices nothing', async () => {
    const { clock, knobA, knobB, one, two } = await twoPlayers();
    const before = [...two.statuses];
    knobA.drop();
    assert.equal(one.link.state, 'lost');
    assert.equal(two.link.state, 'ready');
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    knobA.tx.notify('!hello ekko 1\n');
    assert.equal(one.link.state, 'ready');
    assert.equal(one.link.deviceId, knobA.id);
    assert.equal(two.link.deviceId, knobB.id);
    assert.deepEqual(two.statuses, before);
    assert.equal(knobB.connectAt.length, 1);
  });

  it('both knobs gone at once: each returns to its own slot, in any order', async () => {
    const { clock, knobA, knobB, one, two } = await twoPlayers();
    knobA.plan = ['fail', 'fail', 'fail'];
    knobA.drop();
    knobB.drop();
    await clock.advance(BLE.RECONNECT_BACKOFF_MS[0] + 10);
    assert.equal(two.link.state, 'handshake', 'knob B is back first');
    assert.equal(one.link.state, 'lost');
    await clock.advance(10_000);
    knobA.tx.notify('!hello ekko 1\n');
    knobB.tx.notify('!hello ekko 1\n');
    assert.equal(one.link.deviceId, knobA.id);
    assert.equal(two.link.deviceId, knobB.id);
    assert.equal(one.link.state, 'ready');
    assert.equal(two.link.state, 'ready');
  });

  it('a knob that was let go of is free for the other player', async () => {
    const clock = new FakeClock();
    const bluetooth = new FakeBluetooth();
    const knob = new FakeDevice(clock);
    const one = await ready({ clock, bluetooth, device: knob });
    await one.link.disconnect();
    const two = makeLink(bluetooth, clock);
    await two.link.connect();
    knob.tx.notify('!hello ekko 1\n');
    assert.equal(two.link.state, 'ready');
    assert.equal(one.link.state, 'idle');
  });

  it('picking a taken knob while waiting for your own does not give yours up', async () => {
    const { clock, bluetooth, knobA, knobB, one, two } = await twoPlayers();
    knobB.plan = ['fail'];
    knobB.drop();
    bluetooth.pick = knobA;
    await two.link.connect();
    assert.equal(two.statuses.at(-1), 'error:taken');
    assert.equal(two.link.deviceId, knobB.id);
    await clock.advance(10_000);
    assert.equal(two.link.state, 'handshake', 'its own knob still comes back');
    assert.equal(one.link.state, 'ready');
  });
});
