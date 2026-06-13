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
      clearTerminal: {
        mac: { modifiers: ["cmd"], key: "k" },
        linux: { modifiers: ["ctrl"], key: "k" },
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

describe("useShortcuts", () => {
  it("fires onClearTerminal for cmd+k on mac", async () => {
    getPlatformMock.mockResolvedValue("mac");
    loadKeybindingsMock.mockResolvedValue(config());
    const onClearTerminal = vi.fn();

    renderHook(() =>
      useShortcuts({
        projectCount: 1,
        onProject: vi.fn(),
        onNextTab: vi.fn(),
        onPreviousTab: vi.fn(),
        onCloseTopTab: vi.fn(),
        onNewTerminalTab: vi.fn(),
        onClearTerminal,
      }),
    );

    // Wait for the async keybindings load and the resulting state update.
    await vi.waitFor(() => expect(loadKeybindingsMock).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    const event = dispatchKeydown({ metaKey: true, key: "k" });

    expect(onClearTerminal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("fires onClearTerminal for ctrl+k on linux", async () => {
    getPlatformMock.mockResolvedValue("linux");
    loadKeybindingsMock.mockResolvedValue(config());
    const onClearTerminal = vi.fn();

    renderHook(() =>
      useShortcuts({
        projectCount: 1,
        onProject: vi.fn(),
        onNextTab: vi.fn(),
        onPreviousTab: vi.fn(),
        onCloseTopTab: vi.fn(),
        onNewTerminalTab: vi.fn(),
        onClearTerminal,
      }),
    );

    await vi.waitFor(() => expect(loadKeybindingsMock).toHaveBeenCalled());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    dispatchKeydown({ ctrlKey: true, key: "k" });

    expect(onClearTerminal).toHaveBeenCalledTimes(1);
  });
});
