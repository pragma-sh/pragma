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
const terminalScrollToBottom = vi.fn();

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
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    modes = { mouseTrackingMode: "none" as "none" | "x10" | "vt200" | "drag" | "any" };
    onData = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    writeln = vi.fn();
    clear = terminalClear;
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
  MOUSE_WHEEL_REPORT_INTERVAL_MS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK_LINES,
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

  it("leaves xterm wheel sensitivity at defaults so mouse-tracking TUIs receive raw wheel input", async () => {
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

    expect(terminal!.options.scrollSensitivity).toBeUndefined();
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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

    manager.scrollToBottom(tab.id);

    expect(terminalScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("ignores scrollToBottom for an unknown tab", () => {
    terminalScrollToBottom.mockClear();
    const manager = new TerminalManager();
    manager.scrollToBottom("missing");
    expect(terminalScrollToBottom).not.toHaveBeenCalled();
  });

  it("loads the WebGL renderer addon so xterm does not use the DOM renderer", async () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);
    await Promise.resolve();
    await Promise.resolve();

    const terminal = (
      Terminal as unknown as {
        instances: Array<{ loadAddon: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances.at(-1);
    const webgl = (
      WebglAddon as unknown as {
        instances: Array<{ onContextLoss: Mock<(...args: unknown[]) => unknown> }>;
      }
    ).instances.at(-1);

    expect(webgl).toBeDefined();
    expect(webgl!.onContextLoss).toHaveBeenCalledWith(expect.any(Function));
    expect(terminal!.loadAddon).toHaveBeenCalledWith(webgl);
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

    // ...and flush coalesced into a single write when the first one completes.
    releaseWrite!();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

    expect(terminal!.write).toHaveBeenCalledTimes(2);
    expect(decodeOutput(terminal!.write.mock.calls[1]![0])).toBe("secondthird");
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
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();

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

  it("forwards TUI mouse wheel reports immediately so apps can intercept scrolling", () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);

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
        }>;
      }
    ).instances.at(-1);
    const handler = terminal!.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;

    // mouseTrackingMode === "none" → local scrollback scrolling stays untouched.
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
  });

  it("throttles a flood of wheel reports while a TUI consumes mouse input", () => {
    const manager = new TerminalManager();
    const element = document.createElement("div");
    document.body.append(element);

    manager.mount(tab, "/repo", element);

    const terminal = (
      Terminal as unknown as {
        instances: Array<{
          attachCustomWheelEventHandler: Mock<(...args: unknown[]) => unknown>;
          modes: { mouseTrackingMode: string };
        }>;
      }
    ).instances.at(-1);
    terminal!.modes.mouseTrackingMode = "any";
    const handler = terminal!.attachCustomWheelEventHandler.mock.calls[0]![0] as (
      event: WheelEvent,
    ) => boolean;

    let clock = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      // Leading event passes; a same-instant burst is dropped instead of
      // flooding the PTY with full-grid redraws.
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(false);
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(false);
      // Once the interval elapses, the next event is forwarded again.
      clock += MOUSE_WHEEL_REPORT_INTERVAL_MS;
      expect(handler(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
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
