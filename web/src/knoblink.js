// One player's knob, whatever it is connected with. Holds one link per
// transport (cable: SerialLink, wireless: BleLink), lets exactly one of them
// be the active one and looks like a single link to main.js. No DOM and no
// browser API in here: the links are built by the factories passed in.
//
// Rules:
//   - The active transport is the last one the player asked for. Until they
//     ask, it is the first one this browser supports.
//   - Choosing the other transport lets go of the one in use first: a knob is
//     never held over both at once, and the cable link stops reopening its
//     port by itself.
//   - Lines and status from a link that is not the active one are ignored.

export class KnobLink {
  #links = {};
  #kinds = [];
  #kind;

  /**
   * @param {object} options
   * @param {Record<string, (handlers: object) => object>} options.transports
   *        link factories by kind, in order of preference, e.g. { usb, ble }
   * @param {(line: string) => void} options.onLine
   * @param {(status: {state: string, detail?: string, kind: string, name: string|null}) => void} options.onStatus
   * @param {(line: string) => void} [options.onIgnored]
   */
  constructor({ transports, onLine, onStatus, onIgnored }) {
    this.onLine = onLine;
    this.onStatus = onStatus;
    this.onIgnored = onIgnored;
    this.#kinds = Object.keys(transports);
    this.#kind = this.#kinds[0];
    for (const kind of this.#kinds) {
      this.#links[kind] = transports[kind]({
        onLine: (line) => {
          if (kind === this.#kind) this.onLine(line);
        },
        onStatus: (status) => {
          if (kind === this.#kind) this.#emit(status);
        },
        onIgnored: (line) => {
          if (kind === this.#kind && this.onIgnored) this.onIgnored(line);
        },
      });
    }
    this.#kind = this.#kinds.find((kind) => this.#links[kind].supported) ?? this.#kinds[0];
  }

  /** The active transport: 'usb' or 'ble'. */
  get kind() {
    return this.#kind;
  }

  get state() {
    return this.#active.state;
  }

  /** True while lines can be sent. */
  get isOpen() {
    return this.#active.isOpen;
  }

  /** The knob's own name where the transport knows one (`Ekko-XXXX` over BLE). */
  get name() {
    return this.#active.name ?? null;
  }

  /** Write queue counters of the active link, where it has any. */
  get stats() {
    return this.#active.stats ?? null;
  }

  /** True when this browser can use that transport. */
  supports(kind) {
    return !!this.#links[kind] && this.#links[kind].supported;
  }

  /**
   * Ask the user for a knob over `kind` (default: the active transport).
   * Must be called from a user gesture.
   */
  connect(kind = this.#kind) {
    if (!this.supports(kind)) return Promise.resolve();
    if (kind !== this.#kind) {
      const previous = this.#active;
      // Switch first: what the old link reports while closing is not ours.
      this.#kind = kind;
      Promise.resolve(previous.disconnect()).catch(() => {});
      this.#emit({ state: this.#active.state });
    }
    return this.#active.connect();
  }

  /** Reopen a knob granted on an earlier visit, where the transport can. */
  reconnectKnown() {
    return this.#active.reconnectKnown();
  }

  /** Sends one line over the active transport. */
  send(line) {
    return this.#active.send(line);
  }

  /** Lets go of the knob; the active transport stays the chosen one. */
  disconnect() {
    return this.#active.disconnect();
  }

  get #active() {
    return this.#links[this.#kind];
  }

  #emit({ state, detail }) {
    this.onStatus({ state, detail, kind: this.#kind, name: this.name });
  }
}
