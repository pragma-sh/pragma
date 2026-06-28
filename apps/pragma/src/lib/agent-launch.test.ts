import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "@/lib/tauri";

const ptyWriteMock = vi.fn();
const ptySpawnMock = vi.fn();
const writeWhenReadyMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  ptyWrite: (...args: unknown[]) => ptyWriteMock(...args),
  ptySpawn: (...args: unknown[]) => ptySpawnMock(...args),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: { writeWhenReady: (...args: unknown[]) => writeWhenReadyMock(...args) },
  MAX_TERMINAL_COLS: 240,
  MAX_TERMINAL_ROWS: 90,
}));

import { agentStartCommand, startAgentInTab, startBackgroundAgentSession } from "./agent-launch";

const ESC = String.fromCharCode(27);

function agent(start: string[]): AgentConfig {
  return { id: "test", name: "Test", iconDataUrl: null, start };
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
    writeWhenReadyMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the start command after the launch delay", () => {
    startAgentInTab("tab-1", agent(["opencode"]));
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "opencode\r");
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("does not prefill when no message is given", () => {
    startAgentInTab("tab-1", agent(["opencode"]));
    vi.advanceTimersByTime(10_000);
    expect(writeWhenReadyMock).toHaveBeenCalledTimes(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("bracketed-pastes a trimmed prefill then submits separately after the TUI delay", () => {
    startAgentInTab("tab-1", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "claude\r");
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith(
      "tab-1",
      `${ESC}[200~Fix the bug${ESC}[201~`,
    );
    vi.advanceTimersByTime(2500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    // The submit key is a separate, later write so the paste commits first.
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "\r");
    vi.advanceTimersByTime(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("uses agent-configured startup input and prefill delay", () => {
    startAgentInTab(
      "tab-1",
      {
        ...agent(["agent"]),
        startupInput: [{ delayMs: 1000, data: "a\r" }],
        prefillDelayMs: 4000,
      },
      "Fix the bug",
    );
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "agent\r");
    vi.advanceTimersByTime(999);
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "a\r");
    vi.advanceTimersByTime(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "a\r");
    vi.advanceTimersByTime(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    vi.advanceTimersByTime(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("uses agent-configured plain prefill and submit sequence", () => {
    startAgentInTab(
      "tab-1",
      { ...agent(["agent"]), prefillMode: "plain", prefillSubmit: `${ESC}[13;5u` },
      "Fix the bug",
    );
    vi.advanceTimersByTime(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "Fix the bug");
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
    vi.advanceTimersByTime(200);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
  });

  it("honors a per-agent submit delay override", () => {
    startAgentInTab("tab-1", { ...agent(["claude"]), prefillSubmitDelayMs: 50 }, "Fix the bug");
    vi.advanceTimersByTime(3000);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~`);
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", "\r");
    vi.advanceTimersByTime(50);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "\r");
  });

  it("appends selected model args to the start command", () => {
    const selected = {
      ...agent(["agent"]),
      models: { source: "static" as const, modelArg: ["--model", "{model}"], items: [] },
    };
    startAgentInTab("tab-1", selected, undefined, { modelId: "sonnet", reasoningId: null });
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "agent --model sonnet\r");
  });

  it("skips a whitespace-only prefill", () => {
    startAgentInTab("tab-1", agent(["claude"]), "   \n  ");
    vi.advanceTimersByTime(10_000);
    expect(writeWhenReadyMock).toHaveBeenCalledTimes(1);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "claude\r");
  });
});

describe("startBackgroundAgentSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ptyWriteMock.mockReset();
    ptySpawnMock.mockReset();
    writeWhenReadyMock.mockReset();
    ptySpawnMock.mockResolvedValue({ onmessage: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the daemon PTY before sending the start command", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"]));
    expect(ptySpawnMock).toHaveBeenCalledWith(
      "tab-1",
      "wt-1",
      "/cwd",
      expect.any(Number),
      expect.any(Number),
      expect.any(Function),
    );
    // The start command is still gated behind the launch delay.
    expect(ptyWriteMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("bracketed-pastes the prefill then submits separately, like foreground launches", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2499);
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

  it("uses agent-configured plain prefill and submit sequence for background launches", async () => {
    await startBackgroundAgentSession(
      "tab-1",
      "wt-1",
      "/cwd",
      { ...agent(["agent"]), prefillMode: "plain", prefillSubmit: `${ESC}[13;5u` },
      "Fix the bug",
    );
    vi.advanceTimersByTime(3000);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "Fix the bug");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
    vi.advanceTimersByTime(200);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", `${ESC}[13;5u`);
  });
});
