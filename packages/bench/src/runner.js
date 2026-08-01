// Injected into a running Pragma dev build by `pragma-bench run`, through the
// Tauri dev bridge (`tauri-agent-tools eval --file`).
//
// Why the whole scenario lives in the page: a keystroke's latency is measured in
// milliseconds, and every bridge round-trip costs tens of them. Driving one
// keystroke per CLI call would measure the CLI. So the benchmark ships the loop
// into the webview, where send and paint timestamps come from the same
// `performance.now()` clock, and polls it from the outside for progress.
//
// The bridge caps a single eval at five seconds, which is why `start` returns
// immediately and `poll` is a separate call.
//
// Nothing here is app code: the runner reads the app's dev-only hook to reach a
// live xterm instance, and otherwise dispatches the same DOM events a user's
// keyboard and trackpad produce.
/* oxlint-disable unicorn/consistent-function-scoping -- the file is evaluated as
   a single expression inside the webview, so its IIFE *is* the outer scope; a
   helper hoisted out of it would become a global in the app's page. */
/* oxlint-disable no-await-in-loop -- both loops are deliberately sequential in
   real time: typing paces the burst so the renderer gets turns of the event
   loop, and scrolling sends the next notch only after the previous one moved
   the screen. Parallelising either would measure queueing, not latency. */
(() => {
  const CONFIG = __PRAGMA_BENCH_CONFIG__;
  const RUNNER_GLOBAL = CONFIG.runnerGlobal;
  const HOOK_GLOBAL = CONFIG.hookGlobal;

  /** How often the typing burst re-checks for keystrokes still in flight. */
  const DRAIN_TICK_MS = 16;

  const hook = () => window[HOOK_GLOBAL];

  /** Parses the payload's status row: `PRAGMABENCH seq=1 off=3 keys=1 …`. */
  const parseStatus = (text, markerPrefix) => {
    if (typeof text !== "string" || !text.startsWith(markerPrefix)) {
      return null;
    }
    const status = {};
    for (const [, key, value] of text.matchAll(/(\w+)=(\d+)/g)) {
      status[key] = Number(value);
    }
    return status;
  };

  /** First row of whatever buffer is on screen — the payload paints its status there. */
  const topRowText = (terminal) => {
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(buffer.viewportY);
    return line ? line.translateToString(true) : "";
  };

  /**
   * xterm's live mouse-tracking mode — the one fact that says whether a wheel
   * notch becomes a mouse report for the TUI or a scroll of xterm's own
   * scrollback. `TerminalManager` gates its wheel pacing on the same value, so
   * this is the app's own definition of "the TUI owns the wheel", not a proxy.
   */
  const mouseMode = (terminal) => {
    const mode = terminal.modes && terminal.modes.mouseTrackingMode;
    return typeof mode === "string" ? mode : "unknown";
  };

  /**
   * Yields to the page for `ms`, or — when asked for no delay — for the shortest
   * turn of the event loop that still lets the renderer paint.
   *
   * `setTimeout(…, 0)` is *not* that: a timer scheduled from inside a timer
   * callback is nested, and the HTML spec clamps nested timers to 4ms, which
   * would silently cap the typing burst at ~250 characters a second. A message
   * task has no such clamp and still leaves room between tasks for a frame.
   */
  const pause = (ms) =>
    ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.addEventListener(
            "message",
            () => {
              channel.port1.close();
              resolve();
            },
            { once: true },
          );
          // Required with `addEventListener`: a port only delivers once started.
          channel.port1.start();
          channel.port2.postMessage(0);
        });

  class Runner {
    constructor() {
      this.state = null;
    }

    /**
     * Closes any open modal, and reports what is still open.
     *
     * A dialog is not a cosmetic obstacle here: while one is up, the terminal
     * behind it keeps consuming input — the payload's counters advance — but
     * xterm stops emitting `onRender`, so every sample times out and the run
     * reports 100% dropped with no hint as to why. The trust prompt for a
     * project automation is the one that shows up in practice, on any worktree
     * with automations that have not been trusted yet.
     *
     * Escape only. A benchmark must never answer a trust prompt on the user's
     * behalf, so nothing here clicks a button; dismissing leaves the decision
     * exactly where it was, to be asked again next launch.
     */
    dismissModals() {
      const open = () => [...document.querySelectorAll("[role=dialog],[role=alertdialog]")];
      const before = open();
      // One Escape per open dialog: they stack, and Radix closes the topmost.
      for (let index = 0; index < before.length; index += 1) {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      const remaining = open();
      return {
        closed: before.length - remaining.length,
        remaining: remaining.map((dialog) => dialog.textContent.slice(0, 80)),
      };
    }

    /** True once the app has a live terminal for `tabId` (and, for the TUI payload, it has painted). */
    ready(tabId, markerPrefix) {
      // Distinguished from "the tab has not mounted" because the two have
      // completely different fixes, and both used to report the same sentence.
      if (!hook()) {
        return {
          ready: false,
          reason: "the app exposes no bench hook — is this a production build?",
        };
      }
      const terminal = hook().terminal(tabId);
      if (!terminal) {
        // A terminal exists only while its tab is rendered, so listing the
        // mounted ones says whether the app is on the wrong worktree entirely.
        return {
          ready: false,
          reason: `no mounted terminal for tab ${tabId}; mounted: ${
            hook().tabs().join(", ") || "none"
          }`,
        };
      }
      // `mouse` and `altScreen` are reported for every scenario, because which
      // value is correct depends on the scenario and that decision belongs to
      // the caller: the TUI payload must have taken the wheel, the scrollback
      // payload must not have.
      const shape = {
        rows: terminal.rows,
        cols: terminal.cols,
        mouse: mouseMode(terminal),
        altScreen: terminal.buffer.active.type === "alternate",
      };
      if (!markerPrefix) {
        return { ready: true, ...shape };
      }
      const status = parseStatus(topRowText(terminal), markerPrefix);
      return status
        ? { ready: true, ...shape, status }
        : { ready: false, reason: "payload has not painted its status row" };
    }

    /** Begins a scenario and returns at once; progress is read with `poll`. */
    start(options) {
      if (this.state && this.state.running) {
        return { started: false, reason: "a scenario is already running" };
      }
      const terminal = hook()?.terminal(options.tabId);
      const element = hook()?.element(options.tabId);
      if (!terminal || !element) {
        return { started: false, reason: "no terminal for tab " + options.tabId };
      }
      this.state = {
        running: true,
        scenario: options.scenario,
        samples: [],
        dropped: 0,
        sent: 0,
        error: null,
        // Focus is part of the measurement's validity: an occluded window stops
        // receiving animation frames, so xterm never paints and every sample
        // becomes a timeout. Recorded rather than assumed, so a run that lost
        // the window mid-way says so instead of reporting the throttling as lag.
        unfocused: !document.hasFocus(),
        // Which half of the wheel path actually ran. Reported rather than
        // asserted here: the caller knows which scenario wanted which.
        mouse: mouseMode(terminal),
        mouseLost: false,
        xtermScrolled: false,
      };
      const state = this.state;
      this.#run(terminal, element, options, state)
        .catch((error) => {
          state.error = error && error.message ? error.message : String(error);
        })
        .finally(() => {
          state.running = false;
        });
      return { started: true, scenario: options.scenario, mouse: state.mouse };
    }

    /** Progress so far. Samples are returned in full; a run is a few hundred numbers. */
    poll() {
      if (!this.state) {
        return { running: false, started: false };
      }
      return { started: true, ...this.state };
    }

    async #run(terminal, element, options, state) {
      const context = this.#watch(terminal, options, state);
      try {
        terminal.focus();
        if (options.scenario === "typing") {
          await this.#runTyping(element, options, state, context);
        } else {
          await this.#runScroll(element, options, state, context);
        }
      } finally {
        context.dispose();
      }
    }

    /**
     * Subscribes to paints for the length of one scenario.
     *
     * `onRender` fires after xterm has painted, so its timestamp is the closest
     * the page can get to "the user could see it". One subscription serves both
     * loops: the burst reads every frame in order through `onFrame`, the paced
     * loop waits for a specific one through `waitForPaint`.
     */
    #watch(terminal, options, state) {
      const baseViewportY = terminal.buffer.active.viewportY;
      const waiters = new Set();
      const context = {
        terminal,
        painted: { time: 0, status: null, viewportY: baseViewportY },
        onFrame: null,
      };
      const onBlur = () => {
        state.unfocused = true;
      };
      window.addEventListener("blur", onBlur);
      const subscription = terminal.onRender(() => {
        context.painted = {
          time: performance.now(),
          status: parseStatus(topRowText(terminal), options.markerPrefix),
          viewportY: terminal.buffer.active.viewportY,
        };
        // Integrity, not measurement. `scroll-tui` is only that scenario while
        // the payload owns the wheel: if mouse tracking drops out mid-run, or
        // xterm moves its own viewport, the samples that follow are scrollback
        // paints wearing the TUI scenario's name. Both are recorded so the
        // caller can refuse the run instead of publishing the wrong number.
        const mouse = mouseMode(terminal);
        if (mouse === "none" && state.mouse !== "none") {
          state.mouseLost = true;
        }
        state.mouse = mouse;
        if (context.painted.viewportY !== baseViewportY) {
          state.xtermScrolled = true;
        }
        if (context.onFrame) {
          context.onFrame(context.painted);
        }
        for (const waiter of waiters) {
          if (waiter.test(context.painted)) {
            waiter.resolve(context.painted);
          }
        }
      });

      // A deferred rather than work inside the executor: three different things
      // can complete one sample — a later frame, a frame that already landed,
      // and the timeout — and routing all of them through `waiter.resolve`
      // keeps "a sample settles exactly once" a property of one function.
      context.waitForPaint = (test, timeoutMs) => {
        let finish = null;
        const settled = new Promise((resolve) => {
          finish = resolve;
        });
        let timer = 0;
        let done = false;
        const waiter = {
          test,
          resolve: (value) => {
            if (done) {
              return;
            }
            done = true;
            waiters.delete(waiter);
            clearTimeout(timer);
            finish(value);
          },
        };
        timer = setTimeout(() => waiter.resolve(null), timeoutMs);
        // A frame satisfying the test may already have landed between the send
        // and this call; checking first avoids waiting out a whole timeout for
        // a repaint that will never come.
        if (test(context.painted)) {
          waiter.resolve(context.painted);
        } else {
          waiters.add(waiter);
        }
        return settled;
      };

      context.dispose = () => {
        subscription.dispose();
        window.removeEventListener("blur", onBlur);
      };
      return context;
    }

    /**
     * Typing, sent as a burst.
     *
     * Every keystroke goes out on the fastest schedule the page allows and is
     * timed independently, rather than each one waiting for the previous to
     * paint. That is what fast typing and pasting actually look like, and it is
     * where lag is felt: a loop that only sends into an already-caught-up
     * terminal can never observe a queue forming, so it under-reports exactly
     * the case a user complains about.
     *
     * Several keystrokes are therefore in flight at once. The payload's `keys`
     * counter only ever grows, so a frame reporting `keys=n` proves every
     * keystroke up to `n` is on screen, and settles that whole prefix of the
     * queue — each against its *own* send time.
     */
    async #runTyping(element, options, state, context) {
      const pending = [];
      context.onFrame = (frame) => {
        if (!frame.status) {
          return;
        }
        while (pending.length > 0 && frame.status.keys >= pending[0].index) {
          const entry = pending.shift();
          state.samples.push(Number((frame.time - entry.sentAt).toFixed(3)));
        }
      };
      // Swept rather than one timer per keystroke: the queue is ordered by send
      // time, so only its head can be the next to expire.
      const expire = () => {
        const now = performance.now();
        while (pending.length > 0 && now - pending[0].sentAt > options.timeoutMs) {
          pending.shift();
          state.dropped += 1;
        }
      };

      for (let index = 1; index <= options.count; index += 1) {
        const character = options.text[(index - 1) % options.text.length];
        pending.push({ index, sentAt: performance.now() });
        this.#sendKey(element, character);
        state.sent = index;
        await pause(options.gapMs);
        expire();
      }
      // The last keystrokes are still in flight when the send loop ends; every
      // one of them either paints or expires, so this terminates.
      while (pending.length > 0) {
        await pause(DRAIN_TICK_MS);
        expire();
      }
    }

    /**
     * Scrolling, one notch at a time.
     *
     * Unlike keystrokes, wheel notches are deliberately coalesced — by xterm's
     * pixel accumulator and by `TerminalManager`'s wheel pacing — so a burst
     * would produce fewer screen movements than notches sent, with no way to
     * attribute a movement to a notch. Sending the next only after the screen
     * moved keeps one notch equal to one sample.
     */
    async #runScroll(element, options, state, context) {
      // The scrollback payload parks at the *bottom* of its 5000 lines, so a
      // downward notch has nowhere to go and every sample times out — 100%
      // dropped, which reads as lag but is geometry. Start upward there, and
      // turn round at either end so the count can be raised without walking off
      // the buffer. (`scroll-tui` needs none of this: the TUI wraps its own
      // offset, and its alternate buffer has no scrollback to reach the end of.)
      let direction = options.scenario === "scroll-buffer" ? -1 : 1;
      for (let index = 1; index <= options.count; index += 1) {
        const before = context.painted;
        const test = this.#scrollTest(options.scenario, before);
        direction = this.#turnAtTheEnds(options.scenario, context.terminal, direction);
        const sentAt = performance.now();
        this.#sendWheel(element, options.deltaY * direction);
        state.sent = index;
        const frame = await context.waitForPaint(test, options.timeoutMs);
        if (frame) {
          state.samples.push(Number((frame.time - sentAt).toFixed(3)));
        } else {
          state.dropped += 1;
        }
        if (options.gapMs > 0) {
          await pause(options.gapMs);
        }
      }
    }

    /**
     * Reverses the wheel once the scrollback has nothing left in that direction.
     * Only `scroll-buffer` can run out: xterm's own viewport is bounded by the
     * scrollback, whereas the TUI wraps its offset.
     */
    #turnAtTheEnds(scenario, terminal, direction) {
      if (scenario !== "scroll-buffer") {
        return direction;
      }
      const buffer = terminal.buffer.active;
      if (direction < 0 && buffer.viewportY <= 0) {
        return 1;
      }
      if (direction > 0 && buffer.viewportY >= buffer.baseY) {
        return -1;
      }
      return direction;
    }

    /** What "this wheel notch has been rendered" means for each scroll scenario. */
    #scrollTest(scenario, before) {
      if (scenario === "scroll-tui") {
        // Offset, not wheel count: a wheel report the app paced away never moves
        // the payload, and a scroll that did not move is not a scroll a user saw.
        const offsetBefore = before.status ? before.status.off : -1;
        return (frame) => Boolean(frame.status) && frame.status.off !== offsetBefore;
      }
      if (scenario === "scroll-buffer") {
        // No payload involvement here, so the viewport row is the only signal.
        const viewportBefore = before.viewportY;
        return (frame) => frame.viewportY !== viewportBefore;
      }
      throw new Error("unknown scenario " + scenario);
    }

    /**
     * A keystroke as xterm sees one: a keydown on its hidden helper textarea.
     *
     * Not every printable character can be sent this way. xterm takes the
     * printable path in `evaluateKeyboardEvent` only for `keyCode >= 48`;
     * anything below — space at 32, above all — reaches a real terminal through
     * the textarea's `keypress`/`input` event, which the browser generates only
     * for genuine key input. Such a keystroke would be dispatched, silently
     * never arrive, and be counted as a dropped frame, so it fails loudly here
     * instead.
     */
    #sendKey(element, character) {
      const target =
        element.querySelector(".xterm-helper-textarea") ?? element.querySelector(".xterm");
      if (!target) {
        throw new Error("terminal has no keyboard target");
      }
      const upper = character.toUpperCase();
      if (upper.charCodeAt(0) < 48) {
        throw new Error(JSON.stringify(character) + " cannot be delivered as a synthetic keydown");
      }
      const code = /[a-z]/i.test(character)
        ? "Key" + upper
        : /[0-9]/.test(character)
          ? "Digit" + character
          : "";
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: character,
          code,
          keyCode: upper.charCodeAt(0),
          which: upper.charCodeAt(0),
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }

    /** A trackpad notch as xterm sees one: a pixel-mode wheel event on the screen element. */
    #sendWheel(element, deltaY) {
      const target = element.querySelector(".xterm-screen") ?? element.querySelector(".xterm");
      if (!target) {
        throw new Error("terminal has no scroll target");
      }
      target.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }
  }

  window[RUNNER_GLOBAL] = new Runner();
  return "installed";
})();
