import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { constants } from "@pragma-sh/constants";

import type { AgentConfig } from "@/lib/tauri";
import { AGENT_COMMAND_SUBMITTED_EVENT } from "./agent-plugin-prompt";

const ptyWriteMock = vi.fn();
const ptySpawnMock = vi.fn();
const ptySpawnDetachedMock = vi.fn();
const writeWhenReadyMock = vi.fn();
const whenConnectedMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  ptyWrite: (...args: unknown[]) => ptyWriteMock(...args),
  ptySpawn: (...args: unknown[]) => ptySpawnMock(...args),
  ptySpawnDetached: (...args: unknown[]) => ptySpawnDetachedMock(...args),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: {
    writeWhenReady: (...args: unknown[]) => writeWhenReadyMock(...args),
    whenConnected: (...args: unknown[]) => whenConnectedMock(...args),
  },
  MAX_TERMINAL_COLS: 240,
  MAX_TERMINAL_ROWS: 90,
}));

import { agentStartCommand, startAgentInTab, startBackgroundAgentSession } from "./agent-launch";

const ESC = String.fromCharCode(27);

function agent(start: string[]): AgentConfig {
  return { id: "test", name: "Test", iconDataUrl: null, start };
}

function emitPtyOutput(data: string): void {
  const onEvent = ptySpawnMock.mock.calls[0]?.[5] as ((message: ArrayBuffer) => void) | undefined;
  const bytes = Uint8Array.from([...data].map((character) => character.charCodeAt(0)));
  onEvent?.(bytes.buffer);
}

describe("agentStartCommand", () => {
  it("returns a single-token command verbatim", () => {
    expect(agentStartCommand(["opencode"])).toBe("opencode");
  });

  it("joins plain argv tokens with spaces", () => {
    expect(agentStartCommand(["claude", "--permission-mode", "auto"])).toBe(
      "claude --permission-mode auto",
    );
  });

  it("shell-quotes tokens that need it", () => {
    expect(agentStartCommand(["claude", "hello world"])).toBe("claude 'hello world'");
  });
});

describe("startAgentInTab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock.mockReset();
    ptyWriteMock.mockResolvedValue(undefined);
    writeWhenReadyMock.mockReset();
    whenConnectedMock.mockReset();
    whenConnectedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the start command after the launch delay", async () => {
    const listener = vi.fn();
    window.addEventListener(AGENT_COMMAND_SUBMITTED_EVENT, listener);
    startAgentInTab("tab-1", agent(["opencode"]));
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "opencode\r");
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ command: "opencode" });
    window.removeEventListener(AGENT_COMMAND_SUBMITTED_EVENT, listener);
  });

  it("does not prefill when no message is given", async () => {
    startAgentInTab("tab-1", agent(["opencode"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writeWhenReadyMock).toHaveBeenCalledTimes(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("bracketed-pastes a trimmed prefill then submits separately after the TUI delay", async () => {
    startAgentInTab("tab-1", agent(["claude"]), "Fix the bug");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "claude\r");
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith(
      "tab-1",
      `${ESC}[200~Fix the bug${ESC}[201~`,
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    // The submit key is a separate, later write so the paste commits first.
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "\r");
    await vi.advanceTimersByTimeAsync(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("uses agent-configured startup input and prefill delay", async () => {
    startAgentInTab(
      "tab-1",
      {
        ...agent(["agent"]),
        startupInput: [{ delayMs: 1000, data: "a\r" }],
        prefillDelayMs: 4000,
      },
      "Fix the bug",
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "agent\r");
    await vi.advanceTimersByTimeAsync(999);
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "a\r");
    await vi.advanceTimersByTimeAsync(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "a\r");
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    await vi.advanceTimersByTimeAsync(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("uses agent-configured plain prefill and submit sequence", async () => {
    startAgentInTab(
      "tab-1",
      { ...agent(["agent"]), prefillMode: "plain", prefillSubmit: `${ESC}[13;5u` },
      "Fix the bug",
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "Fix the bug");
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
    await vi.advanceTimersByTimeAsync(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
  });

  it("honors a per-agent submit delay override", async () => {
    startAgentInTab("tab-1", { ...agent(["claude"]), prefillSubmitDelayMs: 50 }, "Fix the bug");
    await vi.advanceTimersByTimeAsync(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "\r");
    await vi.advanceTimersByTimeAsync(50);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("appends selected model args to the start command", async () => {
    const selected = {
      ...agent(["agent"]),
      models: { source: "static" as const, modelArg: ["--model", "{model}"], items: [] },
    };
    startAgentInTab("tab-1", selected, undefined, { modelId: "sonnet", reasoningId: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "agent --model sonnet\r");
  });

  it("skips a whitespace-only prefill", async () => {
    startAgentInTab("tab-1", agent(["claude"]), "   \n  ");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writeWhenReadyMock).toHaveBeenCalledTimes(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "claude\r");
  });

  it("waits for the terminal to connect before starting the launch clock", async () => {
    let connect!: () => void;
    whenConnectedMock.mockReturnValue(new Promise<void>((resolve) => (connect = resolve)));
    startAgentInTab("tab-1", agent(["claude"]), "Fix the bug");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(whenConnectedMock).toHaveBeenCalledWith("tab-1");
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    connect();
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "claude\r");
    await vi.advanceTimersByTimeAsync(2500);
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "\r");
    await vi.advanceTimersByTimeAsync(200);
    expect(writeWhenReadyMock).toHaveBeenLastCalledWith("tab-1", "\r");
  });
});

describe("startBackgroundAgentSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock.mockReset();
    ptyWriteMock.mockResolvedValue(undefined);
    ptySpawnMock.mockReset();
    ptySpawnDetachedMock.mockReset();
    writeWhenReadyMock.mockReset();
    ptySpawnMock.mockResolvedValue(undefined);
    ptySpawnDetachedMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the daemon PTY detached before sending the start command", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"]));
    expect(ptySpawnDetachedMock).toHaveBeenCalledWith(
      "tab-1",
      "wt-1",
      "/cwd",
      expect.any(Number),
      expect.any(Number),
    );
    // No prefill to watch for, so the unmounted tab's output never streams into the webview.
    expect(ptySpawnMock).not.toHaveBeenCalled();
    // The start command is still gated behind the launch delay.
    expect(ptyWriteMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("waits for split alternate-screen output before pasting a bracketed prefill", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    emitPtyOutput(`${ESC}[?10`);
    emitPtyOutput(`49h${"redraw".repeat(20)}`);
    vi.advanceTimersByTime(499);
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    vi.advanceTimersByTime(1);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    // The submit Enter is a separate, later write so the paste commits first.
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", "\r");
    vi.advanceTimersByTime(200);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "\r");
    // Background launch never routes through the (unmounted) terminal manager.
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
  });

  it("falls back to sending a bracketed prefill when alternate-screen output never arrives", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500 + 2500 + constants.agents.altScreenExtraWaitMs - 1);
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    vi.advanceTimersByTime(1);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
  });

  it("uses agent-configured startup input and prefill delay for background launches", async () => {
    await startBackgroundAgentSession(
      "tab-1",
      "wt-1",
      "/cwd",
      {
        ...agent(["agent"]),
        startupInput: [{ delayMs: 1000, data: "a\r" }],
        prefillDelayMs: 4000,
      },
      "Fix the bug",
    );
    emitPtyOutput(`${ESC}[?1049h`);
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "agent\r");
    vi.advanceTimersByTime(999);
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", "a\r");
    vi.advanceTimersByTime(1);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "a\r");
    vi.advanceTimersByTime(3000);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    vi.advanceTimersByTime(200);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("continues when the PTY session already exists so a racing mount cannot block prefill", async () => {
    ptySpawnMock.mockRejectedValueOnce(new Error("session already exists: tab-1"));
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "claude\r");
    vi.advanceTimersByTime(2500);
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    vi.advanceTimersByTime(constants.agents.altScreenExtraWaitMs);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
  });

  it("still rejects unrelated spawn failures", async () => {
    ptySpawnMock.mockRejectedValueOnce(new Error("daemon offline"));
    await expect(
      startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]), "Fix the bug"),
    ).rejects.toThrow(/daemon offline/);
  });

  it("uses agent-configured plain prefill and submit sequence for background launches", async () => {
    await startBackgroundAgentSession(
      "tab-1",
      "wt-1",
      "/cwd",
      { ...agent(["agent"]), prefillMode: "plain", prefillSubmit: `${ESC}[13;5u` },
      "Fix the bug",
    );
    // A plain prefill needs no alternate-screen tracking, so it spawns detached.
    expect(ptySpawnDetachedMock).toHaveBeenCalled();
    expect(ptySpawnMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "Fix the bug");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
    vi.advanceTimersByTime(200);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
  });
});
