import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Tab } from "@pragma/constants";

const invokeMock = vi.fn();
const channelInstances: Array<{ onmessage: (event: unknown) => void }> = [];

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel<T> {
    onmessage: (event: T) => void = () => {};
    constructor() {
      channelInstances.push(this as unknown as { onmessage: (event: unknown) => void });
    }
  }
  return {
    Channel: MockChannel,
    invoke: (...args: unknown[]) => invokeMock(...args),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const terminalDispose = vi.fn();
const terminalClear = vi.fn();
const terminalReset = vi.fn();
const terminalRefresh = vi.fn();
const terminalScrollToBottom = vi.fn();

interface TerminalMockShape {
  element: HTMLElement | null;
  focus: Mock;
  onData: Mock;
}

vi.mock("@xterm/xterm", () => {
  const instances: MockTerminal[] = [];
  class MockTerminal {
    static instances = instances;
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: unknown;
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    focus = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    modes = { mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any" };
    onData = vi.fn();
    onRender = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    writeln = vi.fn();
    clear = terminalClear;
    reset = terminalReset;
    refresh = terminalRefresh;
    scrollToBottom = terminalScrollToBottom;
    dispose = terminalDispose;
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
    open(container: HTMLElement) {
      this.element = container;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    static instances: MockFitAddon[] = [];
    // Default dimensions for the next constructed instance. Configurable so a
    // test can make the synchronous mount-time fit() compute a non-default size.
    static nextDimensions = { cols: 80, rows: 24 };
    dimensions = { ...MockFitAddon.nextDimensions };
    constructor() {
      MockFitAddon.instances.push(this);
    }
    fit = vi.fn();
    proposeDimensions = vi.fn(() => this.dimensions);
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    activate = vi.fn();
  },
}));

vi.mock("@xterm/addon-webgl", () => {
  const instances: MockWebglAddon[] = [];
  class MockWebglAddon {
    static instances = instances;
    dispose = vi.fn();
    onContextLoss = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return { WebglAddon: MockWebglAddon };
});

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MOUSE_WHEEL_GESTURE_QUIET_MS,
  MOUSE_WHEEL_RENDER_TIMEOUT_MS,
  MOUSE_WHEEL_RESPONSE_TIMEOUT_MS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PENDING_INPUT_MAX_BYTES,
  TERMINAL_PENDING_OUTPUT_MAX_BYTES,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_WRITE_DRAIN_TIMEOUT_MS,
  TERMINAL_WRITE_CHUNK_MAX_BYTES,
  TUI_WHEEL_PENDING_REPORTS,
  WEBGL_RECOVERY_DELAY_MS,
  WEBGL_RECOVERY_MAX_ATTEMPTS,
  WEBGL_RENDERER_CACHE_SIZE,
  TerminalManager,
} from "./terminal-manager";
import { defaultKeybindingsConfig, setLoadedKeybindingsConfig } from "./keybindings";
import {
  clearActivePluginCommandKeybindings,
  setActivePluginCommandKeybindings,
} from "../plugins/command-keybindings";

const tab = { id: "tab-1", worktreeId: "wt-1" } as Tab;

// Build an output ArrayBuffer from the realm's own Uint8Array (TextEncoder can
// produce a cross-realm buffer under jsdom) so it matches the source's
// `instanceof ArrayBuffer` check, mirroring what Tauri delivers in the webview.
const encodeOutput = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0)).buffer;
const decodeOutput = (data: unknown) => String.fromCharCode(...new Uint8Array(data as ArrayBuffer));

async function settleConnection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalManager font configuration", () => {
  it("uses a Nerd Font-first font stack so box-drawing and block glyphs render in text form", () => {
    expect(TERMINAL_FONT_FAMILY).toContain("JetBrainsMonoNL Nerd Font");
    expect(TERMINAL_FONT_FAMILY).toContain("SF Mono");
    expect(TERMINAL_FONT_FAMILY).toContain("Menlo");
    expect(TERMINAL_FONT_FAMILY).toContain("Monaco");
    expect(TERMINAL_FONT_FAMILY).toContain("ui-monospace");
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace\s*$/);
  });

  it("sizes the cell at 14px so half-block glyphs fill the row without an anti-aliased seam", () => {
    expect(TERMINAL_FONT_SIZE).toBe(14);
    expect(TERMINAL_LINE_HEIGHT).toBe(1.0);
  });

  it("exposes the same font configuration on the manager class", () => {
    expect(TerminalManager.fontFamily).toBe(TERMINAL_FONT_FAMILY);
    expect(TerminalManager.fontSize).toBe(TERMINAL_FONT_SIZE);
    expect(TerminalManager.lineHeight).toBe(TERMINAL_LINE_HEIGHT);
  });

  // This previously asserted the opposite — that both options stay at xterm's
  // defaults so a mouse-tracking TUI receives raw wheel input. That protected the
  // wrong thing: `scrollSensitivity` only gates how often xterm's accumulator
  // crosses a whole line, and the report rate reaching a TUI is bounded by
  // terminal-manager's response gate regardless. Meanwhile leaving it at 1 left
  // xterm's own scrollback scrolling at ~30% of finger distance on a trackpad
  // (xterm damps sub-50px pixel deltas by 0.3), which is the scroll that actually
  // felt slow next to other terminals.
  it("scales wheel sensitivity so trackpad scrolling is not damped to a third", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          options: { fastScrollSensitivity?: number; scrollSensitivity?: number };
        }>;
      }
    ).instances.at(-1);

    expect(terminal!.options.scrollSensitivity).toBe(3);
    // Left at xterm's default: it is multiplied by `scrollSensitivity`, so
    // alt-scroll already scales with the value above.
    expect(terminal!.options.fastScrollSensitivity).toBeUndefined();
  });

  it("bounds xterm scrollback so long sessions do not overload renderer state", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{ options: { scrollback?: number } }>;
      }
    ).instances.at(-1);

    expect(terminal!.options.scrollback).toBe(TERMINAL_SCROLLBACK_LINES);
  });
});

describe("TerminalManager lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    terminalDispose.mockClear();
    terminalClear.mockClear();
    terminalReset.mockClear();
    terminalRefresh.mockClear();
  });

  it("kills the daemon session and disposes the xterm widget on dispose", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    // Let the attach promise settle so the channel is retained.
    await Promise.resolve();
    await Promise.resolve();

    manager.dispose(tab.id);

    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { sessionId: tab.id });
  });

  it("parks and reparents the same xterm and stream across ordinary view unmounts", async () => {
    const manager = new TerminalManager();
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    const hostGeneration = manager.mount(tab, "/repo", firstHost);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const terminal = (Terminal as unknown as { instances: TerminalMockShape[] }).instances.at(-1)!;
    const attachCount = invokeMock.mock.calls.filter(
      ([command]) => command === "pty_attach",
    ).length;
    invokeMock.mockClear();

    manager.park(tab.id, hostGeneration);
    manager.mount(tab, "/repo", secondHost);

    expect((Terminal as unknown as { instances: TerminalMockShape[] }).instances.at(-1)).toBe(
      terminal,
    );
    expect(invokeMock).not.toHaveBeenCalledWith("pty_detach", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("pty_kill", expect.anything());
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(0);
    expect(attachCount).toBe(1);
    expect(terminalReset).not.toHaveBeenCalled();
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(secondHost.firstElementChild).toBe(terminal.element);
  });

  it("ignores stale park cleanup after the terminal has moved to a newer host", async () => {
    const manager = new TerminalManager();
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    const firstGeneration = manager.mount(tab, "/repo", firstHost);
    await Promise.resolve();
    await Promise.resolve();
    manager.mount(tab, "/repo", secondHost);
    manager.setVisible(tab.id, true);
    const terminal = (
      Terminal as unknown as { instances: Array<{ focus: Mock; element: HTMLElement | null }> }
    ).instances.at(-1)!;

    manager.park(tab.id, firstGeneration);
    manager.focus(tab.id);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(secondHost.firstElementChild).toBe(terminal.element);
  });

  it("does not let a superseded attach flush queued input", async () => {
    const resolveAttach: Array<() => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === "pty_attach") {
        return new Promise<void>((resolve) => resolveAttach.push(resolve));
      }
      return Promise.resolve(undefined);
    });
    const manager = new TerminalManager();
    const host = document.createElement("div");
    document.body.append(host);

    manager.mount(tab, "/repo", host);
    manager.writeWhenReady(tab.id, "a");
    channelInstances.at(-1)!.onmessage({ event: "disconnected" });
    expect(resolveAttach).toHaveLength(2);

    resolveAttach[0]!();
    await settleConnection();
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(0);

    resolveAttach[1]!();
    await settleConnection();
    expect(invokeMock).toHaveBeenCalledWith("pty_write", { sessionId: tab.id, data: "a" });
  });

  it("attaches when another creator wins the spawn race", async () => {
    let attachCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "pty_attach") {
        attachCalls += 1;
        return attachCalls === 1
          ? Promise.reject(new Error("session not found"))
          : Promise.resolve(undefined);
      }
      if (command === "pty_spawn") {
        return Promise.reject(new Error("daemon error: session already exists: tab-1"));
      }
      return Promise.resolve(undefined);
    });
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_spawn")).toHaveLength(1);
    const terminal = (Terminal as unknown as { instances: Array<{ writeln: Mock }> }).instances.at(
      -1,
    )!;
    expect(terminal.writeln).not.toHaveBeenCalledWith(
      expect.stringContaining("failed to start terminal"),
    );
  });

  it("restarts output stream when queued renderer work exceeds its byte cap", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();
    const terminal = (Terminal as unknown as { instances: Array<{ write: Mock }> }).instances.at(
      -1,
    )!;
    let releaseWrite: (() => void) | undefined;
    terminal.write.mockImplementation((_data: Uint8Array, callback?: () => void) => {
      releaseWrite = callback;
    });
    const channel = channelInstances.at(-1)!;
    const frame = new ArrayBuffer(256 * 1024);

    for (
      let index = 0;
      index <= TERMINAL_PENDING_OUTPUT_MAX_BYTES / frame.byteLength + 1;
      index++
    ) {
      channel.onmessage(frame);
    }
    releaseWrite!();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_detach")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(2);
  });

  it("resumes a disconnected output stream from its accepted byte cursor without reset", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const channel = channelInstances.at(-1)!;
    channel.onmessage({ event: "replay", cursor: 100, reset: false });
    channel.onmessage(encodeOutput("abc"));
    terminalReset.mockClear();

    channel.onmessage({ event: "disconnected" });
    await settleConnection();

    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_detach")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(2);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "pty_attach").at(-1)?.[1],
    ).toEqual(expect.objectContaining({ cursor: 103 }));
    expect(terminalReset).not.toHaveBeenCalled();
  });

  it("resets once when a reconnect cursor fell outside retained server output", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await settleConnection();
    const firstChannel = channelInstances.at(-1)!;
    firstChannel.onmessage({ event: "replay", cursor: 100, reset: false });
    firstChannel.onmessage(encodeOutput("abc"));
    firstChannel.onmessage({ event: "disconnected" });
    await settleConnection();

    channelInstances.at(-1)!.onmessage({ event: "replay", cursor: 200, reset: true });
    await settleConnection();

    expect(terminalReset).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(3);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "pty_attach").at(-1)?.[1],
    ).toEqual(expect.objectContaining({ cursor: null }));
  });

  it("does not flush queued input when the tab is disposed before attach completes", async () => {
    let resolveAttach: ((channel: unknown) => void) | undefined;
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "pty_attach") {
        return new Promise((resolve) => {
          resolveAttach = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    manager.writeWhenReady(tab.id, "echo hi\r");
    manager.dispose(tab.id);

    resolveAttach!({});
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { sessionId: tab.id });
  });

  it("queues xterm input until attach succeeds and flushes it once in byte order", async () => {
    let resolveAttach: (() => void) | undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === "pty_attach") {
        return new Promise<void>((resolve) => {
          resolveAttach = resolve;
        });
      }
      return Promise.resolve(undefined);
    });
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    const terminal = (
      Terminal as unknown as {
        instances: Array<{ onData: Mock<(listener: (data: string) => void) => void> }>;
      }
    ).instances.at(-1)!;
    const onData = terminal.onData.mock.calls[0]![0];
    onData("a");
    onData("b");
    onData("c");

    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(0);
    resolveAttach!();
    await settleConnection();

    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toEqual([
      ["pty_write", { sessionId: tab.id, data: "abc" }],
    ]);
  });

  it("surfaces bounded pre-attach input overflow", () => {
    invokeMock.mockImplementation((command: string) =>
      command === "pty_attach" ? new Promise<void>(() => undefined) : Promise.resolve(undefined),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new TerminalManager();

    expect(manager.writeWhenReady(tab.id, "x".repeat(TERMINAL_PENDING_INPUT_MAX_BYTES))).toBe(true);
    expect(manager.writeWhenReady(tab.id, "y")).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("input queue is full"));
    error.mockRestore();
  });

  it("focuses only the newly activated visible terminal and routes its later input there", async () => {
    const manager = new TerminalManager();
    const tabB = { ...tab, id: "tab-2" };
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    document.body.append(hostA, hostB);
    manager.mount(tab, "/repo", hostA);
    manager.mount(tabB, "/repo", hostB);
    await Promise.resolve();
    await Promise.resolve();
    const terminals = (Terminal as unknown as { instances: TerminalMockShape[] }).instances;
    const terminalA = terminals.at(-2)!;
    const terminalB = terminals.at(-1)!;
    manager.setVisible(tab.id, false);

    manager.focus(tabB.id);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    const onDataB = terminalB.onData.mock.calls[0]![0];
    onDataB("z");

    expect(terminalA.focus).not.toHaveBeenCalled();
    expect(terminalB.focus).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", { sessionId: tabB.id, data: "z" });
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", { sessionId: tab.id, data: "z" });
  });

  it("does not steal delayed focus from another text editor", async () => {
    const manager = new TerminalManager();
    const host = document.createElement("div");
    const renameInput = document.createElement("input");
    document.body.append(host, renameInput);
    manager.mount(tab, "/repo", host);
    const terminal = (Terminal as unknown as { instances: Array<{ focus: Mock }> }).instances.at(
      -1,
    )!;
    renameInput.focus();

    manager.focus(tab.id);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("ignores dispose for an unknown tab without calling the backend", () => {
    const manager = new TerminalManager();
    manager.dispose("missing");
    expect(invokeMock).not.toHaveBeenCalledWith("pty_kill", expect.anything());
  });

  it("clears the xterm widget for a mounted tab", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    manager.clear(tab.id);

    expect(terminalClear).toHaveBeenCalledTimes(1);
  });

  it("ignores clear for an unknown tab", () => {
    const manager = new TerminalManager();
    manager.clear("missing");
    expect(terminalClear).not.toHaveBeenCalled();
  });

  it("scrolls the xterm widget to the bottom for a mounted tab", async () => {
    terminalScrollToBottom.mockClear();
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    manager.scrollToBottom(tab.id);

    expect(terminalScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("ignores scrollToBottom for an unknown tab", () => {
    terminalScrollToBottom.mockClear();
    const manager = new TerminalManager();
    manager.scrollToBottom("missing");
    expect(terminalScrollToBottom).not.toHaveBeenCalled();
  });

  it("retains the WebGL renderer without a full repaint across tab switches", () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    const terminal = (
      Terminal as unknown as {
        instances: Array<{ loadAddon: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances.at(-1)!;
    const webglInstances = (
      WebglAddon as unknown as {
        instances: Array<{
          dispose: Mock<() => void>;
          onContextLoss: Mock<(listener: () => void) => void>;
        }>;
      }
    ).instances;
    const webgl = webglInstances.at(-1)!;

    expect(webgl.onContextLoss).toHaveBeenCalledWith(expect.any(Function));
    expect(terminal.loadAddon).toHaveBeenCalledWith(webgl);

    terminalRefresh.mockClear();
    manager.setVisible(tab.id, false);
    manager.setVisible(tab.id, true);

    expect(webglInstances.at(-1)).toBe(webgl);
    expect(webgl.dispose).not.toHaveBeenCalled();
    expect(terminalRefresh).not.toHaveBeenCalled();
  });

  it("caps fitted dimensions before resizing xterm and the PTY", async () => {
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);

      manager.mount(tab, "/repo", element);
      const fit = (
        FitAddon as unknown as {
          instances: Array<{ dimensions: { cols: number; rows: number } }>;
        }
      ).instances.at(-1);
      fit!.dimensions = { cols: MAX_TERMINAL_COLS + 80, rows: MAX_TERMINAL_ROWS + 40 };

      manager.activate(tab.id);
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

      const terminal = (
        Terminal as unknown as {
          instances: Array<{ resize: Mock<(cols: number, rows: number) => void> }>;
        }
      ).instances.at(-1);

      expect(terminal!.resize).toHaveBeenLastCalledWith(MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS);
      expect(invokeMock).toHaveBeenCalledWith("pty_resize", {
        sessionId: tab.id,
        cols: MAX_TERMINAL_COLS,
        rows: MAX_TERMINAL_ROWS,
      });
    } finally {
      if (offsetParent) {
        Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      } else {
        delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
      }
    }
  });

  it("retries a PTY resize that raced the session spawn so the PTY does not stay at 80x24", async () => {
    // On agent launch the tab is created, fitted, and spawned in the same tick;
    // the fitted resize can reach the daemon before the spawn registers the
    // session ("session not found") and is dropped. The manager must clear its
    // resize cache and retry, otherwise the PTY keeps the 80x24 spawn default
    // while xterm fills the pane and the agent TUI renders in a small corner.
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
    const fitMock = FitAddon as unknown as { nextDimensions: { cols: number; rows: number } };
    // Exceed the caps so the mock terminal's resize() records the fitted size
    // (the mock FitAddon.fit() is a no-op and would leave cols at the default).
    fitMock.nextDimensions = { cols: MAX_TERMINAL_COLS + 80, rows: MAX_TERMINAL_ROWS + 40 };
    let resizeCalls = 0;
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "pty_resize") {
        resizeCalls += 1;
        return resizeCalls < 3
          ? Promise.reject(new Error("daemon error: session not found"))
          : Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);

      manager.mount(tab, "/repo", element);
      // Flush the attach chain plus two failed resizes and their 200ms retries.
      await vi.advanceTimersByTimeAsync(1000);

      expect(resizeCalls).toBe(3);
      expect(invokeMock).toHaveBeenLastCalledWith("pty_resize", {
        sessionId: tab.id,
        cols: MAX_TERMINAL_COLS,
        rows: MAX_TERMINAL_ROWS,
      });

      // A later fit with unchanged dimensions stays deduplicated: the successful
      // resize repopulated the cache, so no further pty_resize is sent.
      manager.activate(tab.id);
      await vi.advanceTimersByTimeAsync(1000);
      expect(resizeCalls).toBe(3);
    } finally {
      vi.useRealTimers();
      fitMock.nextDimensions = { cols: 80, rows: 24 };
      if (offsetParent) {
        Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      } else {
        delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
      }
    }
  });

  it("re-applies the fitted size after a spawn fallback so a reset daemon's PTY matches the window", async () => {
    // A daemon reset makes pty_attach fail; connect() falls back to pty_spawn,
    // which is created with the pre-fit default size. The remote session must
    // still be resized to the real window size once it exists, even though the
    // synchronous mount-time fit() already cached (and tried to send) that size.
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
    const fitMock = FitAddon as unknown as { nextDimensions: { cols: number; rows: number } };
    fitMock.nextDimensions = { cols: MAX_TERMINAL_COLS + 80, rows: MAX_TERMINAL_ROWS + 40 };
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) =>
      command === "pty_attach"
        ? Promise.reject(new Error("session gone after daemon reset"))
        : Promise.resolve(undefined),
    );
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);

      manager.mount(tab, "/repo", element);
      // Flush the attach-reject → spawn → post-connect-fit promise chain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The session was spawned with the pre-fit default size...
      expect(invokeMock).toHaveBeenCalledWith(
        "pty_spawn",
        expect.objectContaining({ sessionId: tab.id, cwd: "/repo", cols: 80, rows: 24 }),
      );
      // ...and a resize to the real (capped) size is re-sent after it connects,
      // in addition to the synchronous mount-time resize (so twice in total).
      const resizes = invokeMock.mock.calls.filter(([command]) => command === "pty_resize");
      expect(resizes).toHaveLength(2);
      for (const [, args] of resizes) {
        expect(args).toEqual({
          sessionId: tab.id,
          cols: MAX_TERMINAL_COLS,
          rows: MAX_TERMINAL_ROWS,
        });
      }
    } finally {
      fitMock.nextDimensions = { cols: 80, rows: 24 };
      if (offsetParent) {
        Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
      } else {
        delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
      }
    }
  });
});

describe("TerminalManager output", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    channelInstances.length = 0;
    terminalDispose.mockClear();
    terminalReset.mockClear();
  });

  it("waits for xterm write callbacks before coalescing queued output", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    const terminal = (
      Terminal as unknown as {
        instances: Array<{ write: Mock<(data: Uint8Array, callback?: () => void) => void> }>;
      }
    ).instances.at(-1);
    let releaseWrite: (() => void) | undefined;
    terminal!.write.mockImplementation((_data: Uint8Array, callback?: () => void) => {
      releaseWrite = callback;
    });

    // Output arrives as raw ArrayBuffers (not JSON). The first write is in
    // flight, so the next two chunks queue behind it...
    channel!.onmessage(encodeOutput("first"));
    channel!.onmessage(encodeOutput("second"));
    channel!.onmessage(encodeOutput("third"));

    expect(terminal!.write).toHaveBeenCalledTimes(1);
    expect(decodeOutput(terminal!.write.mock.calls[0]![0])).toBe("first");

    // ...and flush coalesced into a single write the moment the first completes.
    // Synchronously: the drain used to wait an animation frame per chunk, which
    // capped it at ~60 chunks/s while the server coalesces every 8ms, so a
    // repainting TUI fell steadily behind.
    releaseWrite!();

    expect(terminal!.write).toHaveBeenCalledTimes(2);
    expect(decodeOutput(terminal!.write.mock.calls[1]![0])).toBe("secondthird");
  });

  it("caps every xterm parser write while preserving the exact output stream", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();
    const terminal = (
      Terminal as unknown as {
        instances: Array<{ write: Mock<(data: Uint8Array, callback?: () => void) => void> }>;
      }
    ).instances.at(-1)!;
    const input = Uint8Array.from(
      { length: TERMINAL_WRITE_CHUNK_MAX_BYTES * 2 + 17 },
      (_, index) => index % 251,
    );

    channelInstances.at(-1)!.onmessage(input.buffer);

    const writes = terminal.write.mock.calls.map(([data]) => data);
    expect(writes.every((data) => data.byteLength <= TERMINAL_WRITE_CHUNK_MAX_BYTES)).toBe(true);
    const output = new Uint8Array(input.length);
    let offset = 0;
    for (const data of writes) {
      output.set(data, offset);
      offset += data.length;
    }
    expect(output).toEqual(input);
  });

  it("keeps an in-flight xterm write while rejecting stale output after cursor resume", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();
    const terminal = (
      Terminal as unknown as {
        instances: Array<{ write: Mock<(data: Uint8Array, callback?: () => void) => void> }>;
      }
    ).instances.at(-1)!;
    let releaseWrite: (() => void) | undefined;
    terminal.write.mockImplementation((_data, callback) => {
      releaseWrite = callback;
    });
    const oldChannel = channelInstances.at(-1)!;
    const staleOnEvent = oldChannel.onmessage;
    staleOnEvent(encodeOutput("old"));

    staleOnEvent({ event: "disconnected" });
    staleOnEvent(encodeOutput("stale"));
    expect(terminalReset).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledTimes(1);

    releaseWrite!();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalReset).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(2);

    staleOnEvent(encodeOutput("late"));
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });

  it("recreates an xterm whose parser write never completes", async () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(tab, "/repo", element);
      await settleConnection();
      const terminals = (Terminal as unknown as { instances: Array<{ write: Mock }> }).instances;
      const initialTerminal = terminals.at(-1)!;
      initialTerminal.write.mockImplementation(() => undefined);

      channelInstances.at(-1)!.onmessage({ event: "replay", cursor: 0, reset: false });
      channelInstances.at(-1)!.onmessage(encodeOutput("stuck"));
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_DRAIN_TIMEOUT_MS * 2 + 1);

      const activeTerminal = (
        manager as unknown as { terminals: Map<string, { terminal: unknown }> }
      ).terminals.get(tab.id)?.terminal;
      expect(activeTerminal).toBeDefined();
      expect(activeTerminal).not.toBe(initialTerminal);
      expect(terminalDispose).toHaveBeenCalled();
      manager.dispose(tab.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TerminalManager pending input replacement", () => {
  it("does not replace after cursor movement makes the local mirror uncertain", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{ onData: Mock<(data: string) => void> }>;
      }
    ).instances.at(-1);
    const onData = terminal!.onData.mock.calls[0]![0] as unknown as (data: string) => void;
    onData("hello");
    onData("\x1b[D");

    expect(manager.canReplacePendingInput(tab.id)).toBe(false);
    manager.replaceInPendingInput(tab.id, "goodbye");

    expect(invokeMock).not.toHaveBeenCalledWith(
      "pty_write",
      expect.objectContaining({ data: "\x7f".repeat(5) + "goodbye" }),
    );
  });
});

describe("TerminalManager key passthrough", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    terminalClear.mockClear();
    clearActivePluginCommandKeybindings();
  });

  it("bubbles configured split shortcuts so they reach the window listener", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const instances = (
      Terminal as unknown as {
        instances: Array<{ attachCustomKeyEventHandler: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances;
    const handler = instances.at(-1)?.attachCustomKeyEventHandler;
    expect(handler).toHaveBeenCalled();
    const passthrough = handler!.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;

    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    const horizontal = new KeyboardEvent("keydown", { metaKey: true, key: "/" });
    expect(passthrough(horizontal)).toBe(false);

    const vertical = new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, key: "?" });
    expect(passthrough(vertical)).toBe(false);
  });

  it("uses the loaded user config for passthrough decisions", async () => {
    setLoadedKeybindingsConfig({
      version: 1,
      bindings: {
        ...defaultKeybindingsConfig.bindings,
        splitHorizontal: {
          mac: { modifiers: ["cmd"], key: "h" },
          linux: { modifiers: ["ctrl"], key: "h" },
        },
      },
    });

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const instances = (
      Terminal as unknown as {
        instances: Array<{ attachCustomKeyEventHandler: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances;
    const handler = instances.at(-1)?.attachCustomKeyEventHandler;
    const passthrough = handler!.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;

    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    expect(passthrough(new KeyboardEvent("keydown", { metaKey: true, key: "h" }))).toBe(false);
    expect(passthrough(new KeyboardEvent("keydown", { metaKey: true, key: "/" }))).toBe(true);
  });

  it("bubbles active plugin command shortcuts so they reach the window listener", async () => {
    setActivePluginCommandKeybindings([{ bindings: [{ chord: "cmd+y" }] }]);

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const instances = (
      Terminal as unknown as {
        instances: Array<{ attachCustomKeyEventHandler: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances;
    const handler = instances.at(-1)?.attachCustomKeyEventHandler;
    const passthrough = handler!.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;

    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    expect(passthrough(new KeyboardEvent("keydown", { metaKey: true, key: "y" }))).toBe(false);
    expect(passthrough(new KeyboardEvent("keydown", { metaKey: true, key: "u" }))).toBe(true);
  });
});

describe("TerminalManager native OS text editing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setLoadedKeybindingsConfig(defaultKeybindingsConfig);
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });

  async function passthroughHandler() {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    const instances = (
      Terminal as unknown as {
        instances: Array<{ attachCustomKeyEventHandler: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances;
    const handler = instances.at(-1)?.attachCustomKeyEventHandler;
    return handler!.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;
  }

  it("writes Ctrl+U for Cmd+Backspace on mac and stops xterm processing", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "Backspace" });
    const preventDefault = vi.spyOn(event, "preventDefault");

    expect(passthrough(event)).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x15",
    });
  });

  it("writes ESC+B for Option+Left on mac", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { altKey: true, key: "ArrowLeft" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x1bb",
    });
  });

  it("writes ESC+F for Option+Right on mac", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { altKey: true, key: "ArrowRight" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x1bf",
    });
  });

  it("writes Ctrl+A for Cmd+Left on mac", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "ArrowLeft" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x01",
    });
  });

  it("writes Ctrl+E for Cmd+Right on mac", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "ArrowRight" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x05",
    });
  });

  it("takes precedence over the configured deleteFile shortcut (Cmd+Backspace)", async () => {
    // Cmd+Backspace is configured as deleteFile in the default keybindings, but
    // in the terminal it must delete the line (Ctrl+U), not bubble up to the
    // delete-file action.
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { metaKey: true, key: "Backspace" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x15",
    });
  });

  it("writes ESC+B for Ctrl+Left on linux", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { ctrlKey: true, key: "ArrowLeft" });

    expect(passthrough(event)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x1bb",
    });
  });

  it("still bubbles configured app shortcuts that are not native editing chords", async () => {
    const passthrough = await passthroughHandler();
    // Cmd+/ is splitHorizontal, not a native editing chord → bubbles up.
    expect(passthrough(new KeyboardEvent("keydown", { metaKey: true, key: "/" }))).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });
});

describe("TerminalManager Shift+Enter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setLoadedKeybindingsConfig(defaultKeybindingsConfig);
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });

  async function passthroughHandler() {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    const instances = (
      Terminal as unknown as {
        instances: Array<{ attachCustomKeyEventHandler: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances;
    const handler = instances.at(-1)?.attachCustomKeyEventHandler;
    return handler!.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;
  }

  it("writes ESC+CR for Shift+Enter so TUI REPLs insert a soft newline", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { shiftKey: true, key: "Enter" });
    const preventDefault = vi.spyOn(event, "preventDefault");

    expect(passthrough(event)).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: "\x1b\r",
    });
  });

  it("lets a plain Enter fall through to xterm so the shell still receives a CR", async () => {
    const passthrough = await passthroughHandler();
    const event = new KeyboardEvent("keydown", { key: "Enter" });

    expect(passthrough(event)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });

  it("blocks legacy keypress Enter events so WebKit cannot submit twice", async () => {
    const passthrough = await passthroughHandler();

    expect(passthrough(new KeyboardEvent("keypress", { key: "Enter" }))).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });

  it("lets legacy keypress text events reach xterm", async () => {
    const passthrough = await passthroughHandler();

    expect(passthrough(new KeyboardEvent("keypress", { key: " " }))).toBe(true);
    expect(passthrough(new KeyboardEvent("keypress", { key: "A", shiftKey: true }))).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });

  it("does not rewrite Cmd/Ctrl/Alt+Enter so the original keybinding reaches xterm", async () => {
    const passthrough = await passthroughHandler();
    for (const event of [
      new KeyboardEvent("keydown", { metaKey: true, key: "Enter" }),
      new KeyboardEvent("keydown", { ctrlKey: true, key: "Enter" }),
      new KeyboardEvent("keydown", { altKey: true, key: "Enter" }),
    ]) {
      expect(passthrough(event)).toBe(true);
    }
    expect(invokeMock).not.toHaveBeenCalledWith("pty_write", expect.anything());
  });
});

describe("TerminalManager mouse input", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("forwards TUI mouse wheel reports immediately so apps can intercept scrolling", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{ onData: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances.at(-1);
    const onData = terminal!.onData.mock.calls[0]![0] as (data: string) => void;
    const wheel = "\x1b[<65;10;5M";

    onData(wheel);

    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      sessionId: tab.id,
      data: wheel,
    });
  });

  it("does not throttle wheel events when no TUI has mouse tracking enabled", () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          options: { scrollSensitivity: number };
        }>;
      }
    ).instances.at(-1);
    const handler = terminal!.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;

    // mouseTrackingMode === "none" → local scrollback scrolling stays untouched.
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(terminal!.options.scrollSensitivity).toBe(3);
  });

  it("uses stock sensitivity while a TUI captures mouse reports", () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          options: { scrollSensitivity: number };
        }>;
      }
    ).instances.at(-1)!;
    const handler = terminal.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;

    terminal.modes.mouseTrackingMode = "any";
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(terminal.options.scrollSensitivity).toBe(1);

    terminal.modes.mouseTrackingMode = "none";
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(terminal.options.scrollSensitivity).toBe(3);
  });

  it("keeps wheel events accumulating while batching emitted TUI reports", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          onData: Mock<(...args: unknown[]) => unknown>;
        }>;
      }
    ).instances.at(-1);
    terminal!.modes.mouseTrackingMode = "any";
    const handler = terminal!.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;
    const onData = terminal!.onData.mock.calls[0]![0] as (data: string) => void;
    const wheel = "\x1b[<65;10;5M";

    let clock = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      // Trackpad pixel deltas can take several events to cross xterm's whole-line
      // threshold. Until xterm emits a report, every event must reach its
      // accumulator or scrolling wedges before the TUI receives anything.
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);

      // First emitted report starts the redraw immediately.
      onData(wheel);
      // Later events still reach xterm's accumulator while their reports wait
      // behind that redraw instead of becoming separate PTY writes.
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(wheel);
      clock += MOUSE_WHEEL_GESTURE_QUIET_MS - 1;
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(wheel);
      clock += MOUSE_WHEEL_GESTURE_QUIET_MS - 1;
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);

      const writes = invokeMock.mock.calls.filter(([command]) => command === "pty_write");
      expect(writes).toHaveLength(1);
      expect(writes[0]![1]).toEqual({ sessionId: tab.id, data: wheel });

      // A quiet gap with no response drops stale queued motion so a deliberate
      // new gesture can go out immediately.
      clock += MOUSE_WHEEL_GESTURE_QUIET_MS;
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(wheel);
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not mistake later keyboard input for a fractional wheel report", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          onData: Mock<(...args: unknown[]) => unknown>;
        }>;
      }
    ).instances.at(-1)!;
    terminal.modes.mouseTrackingMode = "any";
    const handler = terminal.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;
    const onData = terminal.onData.mock.calls[0]![0] as (data: string) => void;

    expect(handler(new WheelEvent("wheel", { deltaY: 1 }))).toBe(true);
    await Promise.resolve();
    onData("a");

    expect(handler(new WheelEvent("wheel", { deltaY: 1 }))).toBe(true);
  });

  it("flushes the queued wheel batch after WebGL paints TUI output", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await settleConnection();

    const channel = channelInstances.at(-1);
    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          onData: Mock<(...args: unknown[]) => unknown>;
          onRender: Mock<(...args: unknown[]) => unknown>;
        }>;
      }
    ).instances.at(-1);
    terminal!.modes.mouseTrackingMode = "any";
    const handler = terminal!.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;
    const onData = terminal!.onData.mock.calls[0]![0] as (data: string) => void;
    const onRender = terminal!.onRender.mock.calls[0]![0] as () => void;
    let finishParsing: (() => void) | undefined;
    (terminal as unknown as { write: Mock }).write.mockImplementation(
      (_data: Uint8Array, callback?: () => void) => {
        finishParsing = callback;
      },
    );
    // Clock frozen, so nothing here can be explained by the interval elapsing.
    let clock = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      const first = "\x1b[<65;10;5M";
      const second = "\x1b[<64;10;5M";
      onData(first);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(second);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(second);

      // Receiving bytes proves the TUI consumed the report, but admitting
      // another report before xterm parses and paints them builds a redraw queue.
      channel!.onmessage(encodeOutput("redraw-start"));
      channel!.onmessage(encodeOutput("redraw-end"));
      clock += MOUSE_WHEEL_GESTURE_QUIET_MS;
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);

      // Parsing first write starts queued second write; gate remains closed
      // until parser catches up and WebGL paints the resulting frame.
      finishParsing!();
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);

      finishParsing!();
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);

      onRender();
      const writes = invokeMock.mock.calls.filter(([command]) => command === "pty_write");
      expect(writes).toHaveLength(2);
      // Both reports queued behind the redraw leave as one write, so the TUI
      // scrolls the distance the gesture actually covered.
      expect(writes[1]![1]).toEqual({ sessionId: tab.id, data: second + second });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("flushes queued wheel reports when a TUI produces no output", async () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(tab, "/repo", element);
      await settleConnection();

      const terminal = (
        Terminal as unknown as {
          instances: Array<{
            attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
            modes: { mouseTrackingMode: string };
            onData: Mock<(...args: unknown[]) => unknown>;
          }>;
        }
      ).instances.at(-1)!;
      terminal.modes.mouseTrackingMode = "any";
      const handler = terminal.attachCustomWheelEventHandler.mock.calls[0]![0] as (
        event: WheelEvent,
      ) => boolean;
      const onData = terminal.onData.mock.calls[0]![0] as (data: string) => void;

      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData("first");
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData("second");

      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(MOUSE_WHEEL_RESPONSE_TIMEOUT_MS);

      const writes = invokeMock.mock.calls.filter(([command]) => command === "pty_write");
      expect(writes).toHaveLength(2);
      expect(writes[1]![1]).toEqual({ sessionId: tab.id, data: "second" });
      manager.dispose(tab.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not admit another wheel report while response bytes still await parsing", async () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(tab, "/repo", element);
      await settleConnection();
      const terminal = (
        Terminal as unknown as {
          instances: Array<{
            attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
            modes: { mouseTrackingMode: string };
            onData: Mock<(...args: unknown[]) => unknown>;
            onRender: Mock<(...args: unknown[]) => unknown>;
            write: Mock;
          }>;
        }
      ).instances.at(-1)!;
      terminal.modes.mouseTrackingMode = "any";
      const handler = terminal.attachCustomWheelEventHandler.mock.calls[0]![0] as (
        event: WheelEvent,
      ) => boolean;
      const onData = terminal.onData.mock.calls[0]![0] as (data: string) => void;
      const onRender = terminal.onRender.mock.calls[0]![0] as () => void;
      let finishParsing: (() => void) | undefined;
      terminal.write.mockImplementation((_data: Uint8Array, callback?: () => void) => {
        finishParsing = callback;
      });

      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData("first");
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData("second");
      channelInstances.at(-1)!.onmessage(encodeOutput("redraw"));

      await vi.advanceTimersByTimeAsync(MOUSE_WHEEL_RESPONSE_TIMEOUT_MS);
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);

      finishParsing!();
      await vi.advanceTimersByTimeAsync(MOUSE_WHEEL_RENDER_TIMEOUT_MS - 1);
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);
      onRender();
      expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(2);
      manager.dispose(tab.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds queued wheel reports and keeps latest gesture input", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await settleConnection();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
          onData: Mock<(...args: unknown[]) => unknown>;
          onRender: Mock<(...args: unknown[]) => unknown>;
        }>;
      }
    ).instances.at(-1)!;
    terminal.modes.mouseTrackingMode = "any";
    const handler = terminal.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;
    const onData = terminal.onData.mock.calls[0]![0] as (data: string) => void;
    const onRender = terminal.onRender.mock.calls[0]![0] as () => void;
    let finishParsing: (() => void) | undefined;
    (terminal as unknown as { write: Mock }).write.mockImplementation(
      (_data: Uint8Array, callback?: () => void) => {
        finishParsing = callback;
      },
    );

    for (let index = 0; index < TUI_WHEEL_PENDING_REPORTS + 3; index += 1) {
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      onData(String(index));
    }
    channelInstances.at(-1)!.onmessage(encodeOutput("redraw"));
    finishParsing!();
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_write")).toHaveLength(1);
    onRender();

    // Oldest queued reports beyond the bound are dropped; the retained tail goes
    // out as one write so the gesture keeps its distance.
    const emitted = Array.from({ length: TUI_WHEEL_PENDING_REPORTS + 3 }, (_, index) =>
      String(index),
    );
    const retained = emitted.slice(-TUI_WHEEL_PENDING_REPORTS).join("");
    const writes = invokeMock.mock.calls.filter(([command]) => command === "pty_write");
    expect(writes).toHaveLength(2);
    expect(writes[0]![1]).toEqual({ sessionId: tab.id, data: "0" });
    expect(writes[1]![1]).toEqual({ sessionId: tab.id, data: retained });
  });

  it("recreates a lost WebGL context with a bounded retry budget", () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(tab, "/repo", element);
      const webglInstances = (
        WebglAddon as unknown as {
          instances: Array<{
            onContextLoss: Mock<(listener: () => void) => void>;
          }>;
        }
      ).instances;
      const initialCount = webglInstances.length;

      for (let attempt = 0; attempt < WEBGL_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
        const current = webglInstances.at(-1)!;
        current.onContextLoss.mock.calls[0]![0]();
        vi.advanceTimersByTime(WEBGL_RECOVERY_DELAY_MS);
      }
      expect(webglInstances).toHaveLength(initialCount + WEBGL_RECOVERY_MAX_ATTEMPTS);

      const final = webglInstances.at(-1)!;
      final.onContextLoss.mock.calls[0]![0]();
      vi.advanceTimersByTime(WEBGL_RECOVERY_DELAY_MS);
      expect(webglInstances).toHaveLength(initialCount + WEBGL_RECOVERY_MAX_ATTEMPTS);
      manager.dispose(tab.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets WebGL recovery budget after a successful paint", () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(tab, "/repo", element);
      const terminal = (
        Terminal as unknown as {
          instances: Array<{ onRender: Mock<(listener: () => void) => void> }>;
        }
      ).instances.at(-1)!;
      const onRender = terminal.onRender.mock.calls[0]![0];
      const webglInstances = (
        WebglAddon as unknown as {
          instances: Array<{ onContextLoss: Mock<(listener: () => void) => void> }>;
        }
      ).instances;
      const initialCount = webglInstances.length;

      for (let attempt = 0; attempt <= WEBGL_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
        webglInstances.at(-1)!.onContextLoss.mock.calls[0]![0]();
        vi.advanceTimersByTime(WEBGL_RECOVERY_DELAY_MS);
        onRender();
      }

      expect(webglInstances).toHaveLength(initialCount + WEBGL_RECOVERY_MAX_ATTEMPTS + 1);
      manager.dispose(tab.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps terminal state and streams warm beyond the WebGL cache budget", () => {
    const manager = new TerminalManager();
    const webglInstances = (
      WebglAddon as unknown as {
        instances: Array<{ dispose: Mock<() => void> }>;
      }
    ).instances;
    const initialCount = webglInstances.length;
    const mountedTabs: Tab[] = [];

    for (let index = 0; index < WEBGL_RENDERER_CACHE_SIZE + 5; index += 1) {
      const currentTab = {
        ...tab,
        id: `webgl-cache-${index}`,
      } as Tab;
      mountedTabs.push(currentTab);
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(currentTab, "/repo", element);
      manager.setVisible(currentTab.id, false);
    }

    const firstWebgl = webglInstances[initialCount]!;
    const oldestWarmWebgl = webglInstances[initialCount + 5]!;
    expect(firstWebgl.dispose).toHaveBeenCalledTimes(1);
    expect(oldestWarmWebgl.dispose).not.toHaveBeenCalled();

    terminalRefresh.mockClear();
    terminalReset.mockClear();
    invokeMock.mockClear();
    manager.setVisible(mountedTabs[0]!.id, true);
    expect(oldestWarmWebgl.dispose).toHaveBeenCalledTimes(1);
    expect(webglInstances).toHaveLength(initialCount + mountedTabs.length + 1);
    expect(terminalRefresh).toHaveBeenCalledWith(0, 23);
    expect(terminalReset).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter(([command]) => command === "pty_attach")).toHaveLength(0);

    for (const currentTab of mountedTabs) {
      manager.dispose(currentTab.id);
    }
  });

  it("trims excess visible WebGL contexts as terminals become hidden", () => {
    const manager = new TerminalManager();
    const webglInstances = (
      WebglAddon as unknown as {
        instances: Array<{ dispose: Mock<() => void> }>;
      }
    ).instances;
    const initialCount = webglInstances.length;
    const mountedTabs: Tab[] = [];

    for (let index = 0; index < WEBGL_RENDERER_CACHE_SIZE + 4; index += 1) {
      const currentTab = { ...tab, id: `visible-webgl-${index}` } as Tab;
      mountedTabs.push(currentTab);
      const element = document.createElement("div");
      document.body.append(element);
      manager.mount(currentTab, "/repo", element);
    }
    expect(
      webglInstances.slice(initialCount).filter((webgl) => !webgl.dispose.mock.calls.length),
    ).toHaveLength(WEBGL_RENDERER_CACHE_SIZE + 4);

    for (const currentTab of mountedTabs) {
      manager.setVisible(currentTab.id, false);
    }
    expect(
      webglInstances.slice(initialCount).filter((webgl) => !webgl.dispose.mock.calls.length),
    ).toHaveLength(WEBGL_RENDERER_CACHE_SIZE);

    for (const currentTab of mountedTabs) {
      manager.dispose(currentTab.id);
    }
  });

  it("keeps output attached while a mounted terminal is hidden", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();
    const terminal = (Terminal as unknown as { instances: Array<{ write: Mock }> }).instances.at(
      -1,
    )!;
    const channel = channelInstances.at(-1)!;
    invokeMock.mockClear();
    terminalReset.mockClear();
    terminalRefresh.mockClear();
    terminal.write.mockClear();

    manager.setVisible(tab.id, false);
    channel.onmessage(encodeOutput("hidden output"));

    expect(terminal.write).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(Function));
    expect(invokeMock).not.toHaveBeenCalledWith("pty_detach", expect.anything());
    expect(terminalReset).not.toHaveBeenCalled();

    manager.setVisible(tab.id, true);
    expect(terminalRefresh).not.toHaveBeenCalled();
  });
});

describe("TerminalManager.onTitle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    channelInstances.length = 0;
  });

  it("forwards shell-emitted titles to subscribed listeners", async () => {
    type PtyEvt = { event: "title"; title: string } | { event: "exit"; code: number | null };

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    // Let the manager's async connect (pty_attach) settle and store the
    // returned Channel in its private map.
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    expect(channel).toBeDefined();
    const onEvent = channel!.onmessage;

    const titles: string[] = [];
    const off = manager.onTitle(tab.id, (title) => titles.push(title));

    onEvent({ event: "title", title: "user@host: ~/repo" } as PtyEvt);
    onEvent({ event: "title", title: "user@host: ~/repo (main)" } as PtyEvt);

    expect(titles).toEqual(["user@host: ~/repo", "user@host: ~/repo (main)"]);

    off();
    onEvent({ event: "title", title: "ignored after unsubscribe" } as PtyEvt);
    expect(titles).toHaveLength(2);
  });

  it("delivers titles to a listener that subscribed before the terminal mounted", async () => {
    type PtyEvt = { event: "title"; title: string } | { event: "exit"; code: number | null };

    const manager = new TerminalManager();

    // Subscribe first — the terminal does not exist in the manager yet. This is
    // the real-world case of a background tab whose pane has not rendered: the
    // subscription must survive until the terminal connects.
    const titles: string[] = [];
    const off = manager.onTitle(tab.id, (title) => titles.push(title));

    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    expect(channel).toBeDefined();
    channel!.onmessage({ event: "title", title: "spawned: ~/repo" } as PtyEvt);

    expect(titles).toEqual(["spawned: ~/repo"]);

    off();
  });

  it("onTitle returns a passive unsubscribe for a tab that never emits", () => {
    const manager = new TerminalManager();
    const off = manager.onTitle("missing", () => {
      throw new Error("listener should not be called");
    });
    expect(off()).toBeUndefined();
  });
});

describe("TerminalManager.onExit", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    channelInstances.length = 0;
  });

  it("forwards the exit code to subscribed listeners", async () => {
    type PtyEvt = { event: "title"; title: string } | { event: "exit"; code: number | null };

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    expect(channel).toBeDefined();
    const onEvent = channel!.onmessage;

    const codes: (number | null)[] = [];
    manager.onExit(tab.id, (code) => codes.push(code));

    onEvent({ event: "exit", code: 0 } as PtyEvt);

    expect(codes).toEqual([0]);
  });

  it("stops delivering after unsubscribe", async () => {
    type PtyEvt = { event: "title"; title: string } | { event: "exit"; code: number | null };

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    const onEvent = channel!.onmessage;

    const codes: (number | null)[] = [];
    const off = manager.onExit(tab.id, (code) => codes.push(code));
    off();

    onEvent({ event: "exit", code: 1 } as PtyEvt);

    expect(codes).toHaveLength(0);
  });

  it("drops listeners once the tab is disposed", async () => {
    type PtyEvt = { event: "title"; title: string } | { event: "exit"; code: number | null };

    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);
    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const channel = channelInstances.at(-1);
    const onEvent = channel!.onmessage;

    const codes: (number | null)[] = [];
    manager.onExit(tab.id, (code) => codes.push(code));
    manager.dispose(tab.id);

    onEvent({ event: "exit", code: 1 } as PtyEvt);

    expect(codes).toHaveLength(0);
  });

  it("onExit returns a passive unsubscribe for a tab that never emits", () => {
    const manager = new TerminalManager();
    const off = manager.onExit("missing", () => {
      throw new Error("listener should not be called");
    });
    expect(off()).toBeUndefined();
  });
});
