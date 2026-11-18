import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KnobLink } from '../src/knoblink.js';

/** A transport link that only records what was asked of it. */
class FakeTransport {
  constructor(handlers, { supported = true, name } = {}) {
    this.handlers = handlers;
    this.supported = supported;
    this.state = supported ? 'idle' : 'unsupported';
    this.isOpen = false;
    this.calls = [];
    this.sent = [];
    if (name !== undefined) this.name = name;
  }

  status(state, detail) {
    this.state = state;
    this.isOpen = state === 'handshake' || state === 'ready';
    this.handlers.onStatus({ state, detail });
  }

  async connect() {
    this.calls.push('connect');
  }

  async reconnectKnown() {
    this.calls.push('reconnectKnown');
  }

  async disconnect() {
    this.calls.push('disconnect');
    if (this.state !== 'idle') this.status('idle');
  }

  send(line) {
    if (!this.isOpen) return false;
    this.sent.push(line);
    return true;
  }
}

function setup({ usb = {}, ble = {} } = {}) {
  const links = {};
  const statuses = [];
  const lines = [];
  const ignored = [];
  const knob = new KnobLink({
    transports: {
      usb: (handlers) => (links.usb = new FakeTransport(handlers, usb)),
      ble: (handlers) => (links.ble = new FakeTransport(handlers, { name: null, ...ble })),
    },
    onLine: (line) => lines.push(line),
    onStatus: (status) => statuses.push(status),
    onIgnored: (line) => ignored.push(line),
  });
  return { knob, links, statuses, lines, ignored };
}

describe('KnobLink: which transport is the active one', () => {
  it('starts on the cable when the browser supports it', () => {
    const { knob } = setup();
    assert.equal(knob.kind, 'usb');
    assert.equal(knob.state, 'idle');
    assert.equal(knob.supports('usb'), true);
    assert.equal(knob.supports('ble'), true);
  });

  it('starts on Bluetooth when only that is supported', () => {
    const { knob } = setup({ usb: { supported: false } });
    assert.equal(knob.kind, 'ble');
    assert.equal(knob.state, 'idle');
    assert.equal(knob.supports('usb'), false);
  });

  it('reports unsupported when the browser has neither', () => {
    const { knob, links } = setup({ usb: { supported: false }, ble: { supported: false } });
    assert.equal(knob.state, 'unsupported');
    knob.connect('usb');
    knob.connect('ble');
    knob.connect();
    assert.deepEqual(links.usb.calls, []);
    assert.deepEqual(links.ble.calls, []);
  });

  it('does not know transports it was not given', () => {
    const { knob } = setup();
    assert.equal(knob.supports('wifi'), false);
    knob.connect('wifi');
    assert.equal(knob.kind, 'usb');
  });

  it('connect() without a kind uses the active transport', () => {
    const { knob, links } = setup();
    knob.connect();
    assert.deepEqual(links.usb.calls, ['connect']);
    assert.deepEqual(links.ble.calls, []);
  });

  it('asking for an unsupported transport changes nothing', () => {
    const { knob, links, statuses } = setup({ ble: { supported: false } });
    links.usb.status('ready');
    knob.connect('ble');
    assert.equal(knob.kind, 'usb');
    assert.equal(knob.state, 'ready');
    assert.deepEqual(links.usb.calls, []);
    assert.equal(statuses.length, 1);
  });
});

describe('KnobLink: switching between cable and Bluetooth', () => {
  it('lets go of the cable before connecting over Bluetooth', () => {
    const { knob, links, statuses } = setup();
    links.usb.status('lost');
    knob.connect('ble');
    assert.equal(knob.kind, 'ble');
    assert.deepEqual(links.usb.calls, ['disconnect'], 'the port stops reopening by itself');
    assert.deepEqual(links.ble.calls, ['connect']);
    // The switch is announced once, as the new transport's state.
    assert.deepEqual(statuses.at(-1), { state: 'idle', detail: undefined, kind: 'ble', name: null });
    assert.equal(statuses.filter((s) => s.kind === 'usb' && s.state === 'idle').length, 0);
  });

  it('lets go of the wireless knob before connecting by cable', () => {
    const { knob, links } = setup({ usb: { supported: true } });
    knob.connect('ble');
    links.ble.status('lost');
    knob.connect('usb');
    assert.equal(knob.kind, 'usb');
    assert.deepEqual(links.ble.calls, ['connect', 'disconnect']);
    assert.deepEqual(links.usb.calls, ['disconnect', 'connect']);
  });

  it('choosing the transport already in use does not disconnect anything', () => {
    const { knob, links } = setup();
    knob.connect('usb');
    knob.connect('usb');
    assert.deepEqual(links.usb.calls, ['connect', 'connect']);
    assert.deepEqual(links.ble.calls, []);
  });

  it('ignores status and lines from the transport that is not in use', () => {
    const { knob, links, statuses, lines, ignored } = setup();
    knob.connect('ble');
    statuses.length = 0;
    // A cable plugged in for power must not take the player's slot back.
    links.usb.status('connecting');
    links.usb.status('ready');
    links.usb.handlers.onLine('!s 1 0 0 0 -7500');
    links.usb.handlers.onIgnored('I (10) boot');
    assert.deepEqual(statuses, []);
    assert.deepEqual(lines, []);
    assert.deepEqual(ignored, []);
    assert.equal(knob.state, 'idle', 'the state is that of the Bluetooth link');
  });

  it('passes on lines, ignored lines and status from the active transport', () => {
    const { knob, links, statuses, lines, ignored } = setup({ ble: { name: 'Ekko-3F2A' } });
    knob.connect('ble');
    statuses.length = 0;
    links.ble.status('handshake');
    links.ble.handlers.onLine('!hello ekko 1');
    links.ble.handlers.onIgnored('noise');
    links.ble.status('ready', 'version');
    assert.deepEqual(lines, ['!hello ekko 1']);
    assert.deepEqual(ignored, ['noise']);
    assert.deepEqual(statuses, [
      { state: 'handshake', detail: undefined, kind: 'ble', name: 'Ekko-3F2A' },
      { state: 'ready', detail: 'version', kind: 'ble', name: 'Ekko-3F2A' },
    ]);
  });
});

describe('KnobLink: looks like one link', () => {
  it('state, isOpen, name and send follow the active transport', () => {
    const { knob, links } = setup({ ble: { name: 'Ekko-3F2A' } });
    assert.equal(knob.name, null, 'a cable has no name');
    assert.equal(knob.isOpen, false);
    assert.equal(knob.send('hello'), false);

    links.usb.status('ready');
    assert.equal(knob.isOpen, true);
    assert.equal(knob.send('hap 14'), true);
    assert.deepEqual(links.usb.sent, ['hap 14']);

    knob.connect('ble');
    assert.equal(knob.isOpen, false);
    assert.equal(knob.send('hap 1'), false);
    links.ble.status('ready');
    assert.equal(knob.name, 'Ekko-3F2A');
    assert.equal(knob.send('hud 1 100 100 1 1'), true);
    assert.deepEqual(links.ble.sent, ['hud 1 100 100 1 1']);
    assert.deepEqual(links.usb.sent, ['hap 14'], 'nothing more went out on the cable');
  });

  it('disconnect() lets go of the knob but keeps the chosen transport', () => {
    const { knob, links, statuses } = setup();
    knob.connect('ble');
    links.ble.status('ready');
    knob.disconnect();
    assert.equal(knob.kind, 'ble');
    assert.equal(knob.state, 'idle');
    assert.equal(statuses.at(-1).state, 'idle');
    assert.deepEqual(links.ble.calls, ['connect', 'disconnect']);
  });

  it('reconnectKnown() goes to the active transport only', () => {
    const { knob, links } = setup();
    knob.reconnectKnown();
    assert.deepEqual(links.usb.calls, ['reconnectKnown']);
    assert.deepEqual(links.ble.calls, []);
  });

  it('stats come from the transport that has a write queue', () => {
    const { knob, links } = setup();
    assert.equal(knob.stats, null);
    links.ble.stats = { waiting: 0 };
    knob.connect('ble');
    assert.deepEqual(knob.stats, { waiting: 0 });
  });
});
