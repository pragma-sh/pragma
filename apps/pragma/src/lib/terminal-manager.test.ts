import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { Tab } from "@pragma/constants";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage: (message: T) => void = () => {};
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const terminalDispose = vi.fn();
const terminalClear = vi.fn();

vi.mock("@xterm/xterm", () => {
  const instances: MockTerminal[] = [];
  class MockTerminal {
    static instances = instances;
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    clear = terminalClear;
    dispose = terminalDispose;
    constructor() {
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
    fit = vi.fn();
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    activate = vi.fn();
  },
}));

import { Terminal } from "@xterm/xterm";

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TerminalManager,
} from "./terminal-manager";
import { defaultKeybindingsConfig, setLoadedKeybindingsConfig } from "./keybindings";

const tab = { id: "tab-1", worktreeId: "wt-1" } as Tab;

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
});

describe("TerminalManager key passthrough", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    terminalClear.mockClear();
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
});
