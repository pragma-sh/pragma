import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { KeybindingsConfig } from "@pragma/constants";

const loadKeybindingsMock = vi.fn();
const getPlatformMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  getPlatform: () => getPlatformMock(),
  loadKeybindings: () => loadKeybindingsMock(),
}));

import { useShortcuts } from "./use-shortcuts";

function config(): KeybindingsConfig {
  return {
    version: 1,
    bindings: {
      nextTab: {
        mac: { modifiers: ["ctrl"], key: "tab" },
        linux: { modifiers: ["alt"], key: "tab" },
      },
      previousTab: {
        mac: { modifiers: ["ctrl", "shift"], key: "tab" },
        linux: { modifiers: ["alt", "shift"], key: "tab" },
      },
      closeTopTab: {
        mac: { modifiers: ["cmd"], key: "w" },
        linux: { modifiers: ["ctrl"], key: "w" },
      },
      newTerminalTab: {
        mac: { modifiers: ["cmd"], key: "t" },
        linux: { modifiers: ["ctrl"], key: "t" },
      },
      newBrowserTab: {
        mac: { modifiers: ["cmd"], key: "b" },
        linux: { modifiers: ["ctrl"], key: "b" },
      },
      clearTerminal: {
        mac: { modifiers: ["cmd"], key: "k" },
        linux: { modifiers: ["ctrl"], key: "k" },
      },
      browserReload: {
        mac: { modifiers: ["cmd"], key: "r" },
        linux: { modifiers: ["ctrl"], key: "r" },
      },
      browserDevtools: {
        mac: { modifiers: ["cmd", "shift"], key: "i" },
        linux: { modifiers: ["ctrl", "shift"], key: "i" },
      },
      browserCopyUrl: {
        mac: { modifiers: ["cmd", "shift"], key: "c" },
        linux: { modifiers: ["ctrl", "shift"], key: "c" },
      },
      splitHorizontal: {
        mac: { modifiers: ["cmd"], key: "/" },
        linux: { modifiers: ["ctrl"], key: "/" },
      },
      splitVertical: {
        mac: { modifiers: ["cmd", "shift"], key: "/" },
        linux: { modifiers: ["ctrl", "shift"], key: "/" },
      },
      switchToWorkspace1: {
        mac: { modifiers: ["ctrl"], key: "1" },
        linux: { modifiers: ["alt"], key: "1" },
      },
      switchToWorkspace2: {
        mac: { modifiers: ["ctrl"], key: "2" },
        linux: { modifiers: ["alt"], key: "2" },
      },
      switchToWorkspace3: {
        mac: { modifiers: ["ctrl"], key: "3" },
        linux: { modifiers: ["alt"], key: "3" },
      },
      switchToWorkspace4: {
        mac: { modifiers: ["ctrl"], key: "4" },
        linux: { modifiers: ["alt"], key: "4" },
      },
      switchToWorkspace5: {
        mac: { modifiers: ["ctrl"], key: "5" },
        linux: { modifiers: ["alt"], key: "5" },
      },
      switchToWorkspace6: {
        mac: { modifiers: ["ctrl"], key: "6" },
        linux: { modifiers: ["alt"], key: "6" },
      },
      switchToWorkspace7: {
        mac: { modifiers: ["ctrl"], key: "7" },
        linux: { modifiers: ["alt"], key: "7" },
      },
      switchToWorkspace8: {
        mac: { modifiers: ["ctrl"], key: "8" },
        linux: { modifiers: ["alt"], key: "8" },
      },
      switchToWorkspace9: {
        mac: { modifiers: ["ctrl"], key: "9" },
        linux: { modifiers: ["alt"], key: "9" },
      },
    },
  };
}

function dispatchKeydown(eventInit: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...eventInit });
  window.dispatchEvent(event);
  return event;
}

/** Full set of shortcut handlers, with `overrides` for the ones under test. */
function options(overrides: Partial<Parameters<typeof useShortcuts>[0]> = {}) {
  return {
    projectCount: 1,
    onProject: vi.fn(),
    onNextTab: vi.fn(),
    onPreviousTab: vi.fn(),
    onCloseTopTab: vi.fn(),
    onNewTerminalTab: vi.fn(),
    onNewBrowserTab: vi.fn(),
    onClearTerminal: vi.fn(),
    onBrowserReload: vi.fn(),
    onBrowserDevtools: vi.fn(),
    onBrowserCopyUrl: vi.fn(),
    onSplitHorizontal: vi.fn(),
    onSplitVertical: vi.fn(),
    ...overrides,
  };
}

async function flushLoad() {
  await vi.waitFor(() => expect(loadKeybindingsMock).toHaveBeenCalled());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("useShortcuts", () => {
  it("fires onClearTerminal for cmd+k on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onClearTerminal = vi.fn();

    renderHook(() => useShortcuts(options({ onClearTerminal })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, key: "k" });

    expect(onClearTerminal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onClearTerminal for ctrl+k on linux", async () => {
    getPlatformMock.mockResolvedValue("linux");
    loadKeybindingsMock.mockResolvedValue(config());
    const onClearTerminal = vi.fn();

    renderHook(() => useShortcuts(options({ onClearTerminal })));

    await flushLoad();
    dispatchKeydown({ ctrlKey: true, key: "k" });

    expect(onClearTerminal).toHaveBeenCalledTimes(1);
  });

  it("fires onNewBrowserTab for cmd+b on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onNewBrowserTab = vi.fn();

    renderHook(() => useShortcuts(options({ onNewBrowserTab })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, key: "b" });

    expect(onNewBrowserTab).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onCloseTopTab for cmd+w on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onCloseTopTab = vi.fn();

    renderHook(() => useShortcuts(options({ onCloseTopTab })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, key: "w" });

    expect(onCloseTopTab).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onBrowserReload for cmd+r and prevents app reload", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onBrowserReload = vi.fn();

    renderHook(() => useShortcuts(options({ onBrowserReload })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, key: "r" });

    expect(onBrowserReload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onBrowserDevtools for cmd+shift+i on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onBrowserDevtools = vi.fn();

    renderHook(() => useShortcuts(options({ onBrowserDevtools })));

    await flushLoad();
    dispatchKeydown({ metaKey: true, shiftKey: true, key: "i" });

    expect(onBrowserDevtools).toHaveBeenCalledTimes(1);
  });

  it("fires onSplitHorizontal for cmd+/ on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onSplitHorizontal = vi.fn();

    renderHook(() => useShortcuts(options({ onSplitHorizontal })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, key: "/" });

    expect(onSplitHorizontal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onSplitVertical for cmd+shift+/ on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onSplitVertical = vi.fn();

    renderHook(() => useShortcuts(options({ onSplitVertical })));

    await flushLoad();
    const event = dispatchKeydown({ metaKey: true, shiftKey: true, key: "?" });

    expect(onSplitVertical).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
