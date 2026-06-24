import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "@/lib/tauri";

const ptyWriteMock = vi.fn();
const writeWhenReadyMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  ptyWrite: (...args: unknown[]) => ptyWriteMock(...args),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: { writeWhenReady: (...args: unknown[]) => writeWhenReadyMock(...args) },
}));

import { agentStartCommand, startAgentInTab } from "./agent-launch";

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
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("does not prefill when no message is given", () => {
    startAgentInTab("tab-1", agent(["opencode"]));
    vi.advanceTimersByTime(10_000);
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
  });

  it("bracketed-pastes a trimmed prefill after the TUI delay", () => {
    startAgentInTab("tab-1", agent(["claude"]), "Fix the bug");
    vi.advanceTimersByTime(500);
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", `${ESC}[200~Fix the bug${ESC}[201~\r`);
  });

  it("appends selected model args to the start command", () => {
    const selected = {
      ...agent(["agent"]),
      models: { source: "static" as const, modelArg: ["--model", "{model}"], items: [] },
    };
    startAgentInTab("tab-1", selected, undefined, { modelId: "sonnet", reasoningId: null });
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "agent --model sonnet\r");
  });

  it("skips a whitespace-only prefill", () => {
    startAgentInTab("tab-1", agent(["claude"]), "   \n  ");
    vi.advanceTimersByTime(10_000);
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
  });
});
