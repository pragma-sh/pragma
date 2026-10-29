import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { constants } from "@pragma-sh/constants";

import type { AgentConfig } from "@/lib/tauri";
import { AGENT_COMMAND_SUBMITTED_EVENT } from "./agent-plugin-prompt";

const ptyWriteMock = vi.fn();
const ptySpawnMock = vi.fn();
const ptySpawnDetachedMock = vi.fn();
const ptyKillMock = vi.fn();
const writeWhenReadyMock = vi.fn();
const writeNoticeMock = vi.fn();
const whenConnectedMock = vi.fn();
const setSpawnEnvMock = vi.fn();
const markLaunchPendingMock = vi.fn();
const clearLaunchPendingMock = vi.fn();
const tabForMock = vi.fn();
const accountsLaunchEnvMock = vi.fn(async () => ({ env: [] as Array<[string, string]> }));
const prepareAgentLaunchMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  ptyWrite: (...args: unknown[]) => ptyWriteMock(...args),
  ptySpawn: (...args: unknown[]) => ptySpawnMock(...args),
  ptySpawnDetached: (...args: unknown[]) => ptySpawnDetachedMock(...args),
  ptyKill: (...args: unknown[]) => ptyKillMock(...args),
  accountsLaunchEnv: (...args: unknown[]) => accountsLaunchEnvMock(...(args as [])),
  prepareAgentLaunch: (...args: unknown[]) => prepareAgentLaunchMock(...args),
}));

vi.mock("@/lib/terminal-manager", () => ({
  terminalManager: {
    writeWhenReady: (...args: unknown[]) => writeWhenReadyMock(...args),
    writeNotice: (...args: unknown[]) => writeNoticeMock(...args),
    whenConnected: (...args: unknown[]) => whenConnectedMock(...args),
    setSpawnEnv: (...args: unknown[]) => setSpawnEnvMock(...args),
    tabFor: (...args: unknown[]) => tabForMock(...args),
    markLaunchPending: (...args: unknown[]) => markLaunchPendingMock(...args),
    clearLaunchPending: (...args: unknown[]) => clearLaunchPendingMock(...args),
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
    ptyKillMock.mockReset();
    ptyKillMock.mockResolvedValue(undefined);
    writeWhenReadyMock.mockReset();
    writeNoticeMock.mockReset();
    whenConnectedMock.mockReset();
    whenConnectedMock.mockResolvedValue(undefined);
    markLaunchPendingMock.mockReset();
    clearLaunchPendingMock.mockReset();
    tabForMock.mockReset();
    tabForMock.mockReturnValue({ worktreeId: "wt-1" });
    prepareAgentLaunchMock.mockReset();
    // Default: the host does not track this agent and returns the argv unchanged.
    prepareAgentLaunchMock.mockImplementation((_worktree, _tab, _agent, command: string[]) =>
      Promise.resolve({ command }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the mounting terminal the harness's account env", async () => {
    startAgentInTab("tab-1", agent(["claude"]));
    const resolve = setSpawnEnvMock.mock.calls.at(-1)?.[1] as
      | ((tab: { worktreeId: string }) => Promise<unknown>)
      | undefined;
    expect(setSpawnEnvMock.mock.calls.at(-1)?.[0]).toBe("tab-1");
    await resolve?.({ worktreeId: "wt-9" });
    expect(accountsLaunchEnvMock).toHaveBeenCalledWith("wt-9", "test", "tab-1");
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

  it("asks the host to prepare the tracked invocation with the worktree, argv, and selection", async () => {
    const selected = {
      ...agent(["claude"]),
      models: { source: "static" as const, modelArg: ["--model", "{model}"], items: [] },
    };
    startAgentInTab("tab-1", selected, "Fix the bug", {
      modelId: "sonnet",
      reasoningId: "high",
      modeId: "plan",
      permissionModeId: "ask",
      slashCommand: "review",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(prepareAgentLaunchMock).toHaveBeenCalledWith(
      "wt-1",
      "tab-1",
      "test",
      ["claude", "--model", "sonnet"],
      {
        modelId: "sonnet",
        reasoningId: "high",
        modeId: "plan",
        permissionModeId: "ask",
        slashCommand: "review",
      },
    );
    expect(markLaunchPendingMock).toHaveBeenCalledWith("tab-1");
    expect(clearLaunchPendingMock).toHaveBeenCalledWith("tab-1");
  });

  it("dispatches the host-formatted tracked command line instead of re-quoting the argv", async () => {
    prepareAgentLaunchMock.mockResolvedValueOnce({
      command: [
        "pragma-cli",
        "agent",
        "run",
        "--run-id",
        "r1",
        "--",
        "claude",
        "C:\\Users\\Ada's project",
      ],
      runId: "r1",
      // What the native host adapter returns for a PowerShell tab: the literal
      // line to type, already quoted for the shell that parses it.
      commandLine: "pragma-cli agent run --run-id r1 -- claude 'C:\\Users\\Ada''s project'",
    });
    startAgentInTab("tab-1", agent(["claude"]));
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith(
      "tab-1",
      "pragma-cli agent run --run-id r1 -- claude 'C:\\Users\\Ada''s project'\r",
    );
    // The desktop never re-joins a tracked argv with POSIX quoting.
    expect(writeWhenReadyMock).not.toHaveBeenCalledWith("tab-1", expect.stringContaining("'\\''"));
  });

  it("keeps the legacy argv when the host does not track the agent", async () => {
    // Unsupported agents come back unchanged with no run id; the launch is
    // byte-identical to the pre-resume behavior, including a single-token
    // command staying raw.
    prepareAgentLaunchMock.mockResolvedValueOnce({ command: ["opencode"] });
    startAgentInTab("tab-1", agent(["opencode"]));
    await vi.advanceTimersByTimeAsync(500);
    expect(writeWhenReadyMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("fails a tracked launch with no host command line instead of joining the argv", async () => {
    // Only the host owns the live session's shell program, so a tracked result
    // without a line is a host error — re-joining here would type a POSIX line
    // into whatever shell the host actually runs.
    prepareAgentLaunchMock.mockResolvedValueOnce({
      command: ["pragma-cli", "agent", "run", "--run-id", "r1", "--", "claude"],
      runId: "r1",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startAgentInTab("tab-1", agent(["claude"]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writeNoticeMock).toHaveBeenCalledWith(
      "tab-1",
      expect.stringContaining("the host returned no command line for a tracked launch"),
    );
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(clearLaunchPendingMock).toHaveBeenCalledWith("tab-1");
    error.mockRestore();
  });

  it("renders a preparation failure as display output, never as PTY input", async () => {
    prepareAgentLaunchMock.mockRejectedValueOnce(new Error("host is unreachable; $(touch pwned)"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startAgentInTab("tab-1", agent(["opencode"]), "Fix the bug");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("agent launch preparation failed for tab-1"),
      expect.any(Error),
    );
    expect(writeNoticeMock).toHaveBeenCalledWith(
      "tab-1",
      expect.stringContaining("could not prepare the agent session: host is unreachable"),
    );
    // Nothing was typed into the shell: the interpolated error must never
    // reach the PTY, and the launch must never fall back to the untracked
    // command or its prefill.
    expect(writeWhenReadyMock).not.toHaveBeenCalled();
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(clearLaunchPendingMock).toHaveBeenCalledWith("tab-1");
    error.mockRestore();
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
    ptyKillMock.mockReset();
    ptyKillMock.mockResolvedValue(undefined);
    writeWhenReadyMock.mockReset();
    writeNoticeMock.mockReset();
    ptySpawnMock.mockResolvedValue(undefined);
    ptySpawnDetachedMock.mockResolvedValue(undefined);
    markLaunchPendingMock.mockReset();
    clearLaunchPendingMock.mockReset();
    prepareAgentLaunchMock.mockReset();
    prepareAgentLaunchMock.mockImplementation((_worktree, _tab, _agent, command: string[]) =>
      Promise.resolve({ command }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the daemon PTY before preparing the tracked invocation", async () => {
    prepareAgentLaunchMock.mockResolvedValueOnce({
      command: ["pragma-cli", "agent", "run", "--run-id", "r1", "--", "opencode"],
      runId: "r1",
      commandLine: "pragma-cli agent run --run-id r1 -- opencode",
    });
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"]));
    expect(prepareAgentLaunchMock).toHaveBeenCalledWith(
      "wt-1",
      "tab-1",
      "test",
      ["opencode"],
      expect.objectContaining({ modelId: null, slashCommand: null }),
    );
    // The session exists before preparation, so the host can render the line
    // from its actual shell program.
    const spawnedAt = ptySpawnDetachedMock.mock.invocationCallOrder[0]!;
    const preparedAt = prepareAgentLaunchMock.mock.invocationCallOrder[0]!;
    expect(spawnedAt).toBeLessThan(preparedAt);
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith(
      "tab-1",
      "pragma-cli agent run --run-id r1 -- opencode\r",
    );
    expect(markLaunchPendingMock).toHaveBeenCalledWith("tab-1");
    expect(clearLaunchPendingMock).toHaveBeenCalledWith("tab-1");
  });

  it("types the host-formatted line for a tracked background launch", async () => {
    prepareAgentLaunchMock.mockResolvedValueOnce({
      command: [
        "pragma-cli",
        "agent",
        "run",
        "--run-id",
        "r1",
        "--",
        "claude",
        "C:\\Users\\Ada's project",
      ],
      runId: "r1",
      commandLine: "pragma-cli agent run --run-id r1 -- claude 'C:\\Users\\Ada''s project'",
    });
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]));
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith(
      "tab-1",
      "pragma-cli agent run --run-id r1 -- claude 'C:\\Users\\Ada''s project'\r",
    );
  });

  it("kills the session it spawned when the host cannot prepare the invocation", async () => {
    prepareAgentLaunchMock.mockRejectedValueOnce(new Error("host is unreachable"));
    await expect(
      startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"])),
    ).rejects.toThrow(/host is unreachable/);
    // The spawn landed before preparation, so this launch owns the session and
    // must not leave it running with no agent in it.
    expect(ptySpawnDetachedMock).toHaveBeenCalled();
    expect(ptyKillMock).toHaveBeenCalledWith("tab-1");
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(clearLaunchPendingMock).toHaveBeenCalledWith("tab-1");
  });

  it("does not kill a session a racing mount already owns when preparation fails", async () => {
    ptySpawnDetachedMock.mockRejectedValueOnce(new Error("session already exists: tab-1"));
    prepareAgentLaunchMock.mockRejectedValueOnce(new Error("host is unreachable"));
    await expect(
      startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"])),
    ).rejects.toThrow(/host is unreachable/);
    // The live PTY was not this launch's to destroy.
    expect(ptyKillMock).not.toHaveBeenCalled();
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("spawns the daemon PTY detached before sending the start command", async () => {
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["opencode"]));
    expect(ptySpawnDetachedMock).toHaveBeenCalledWith(
      "tab-1",
      "wt-1",
      "/cwd",
      expect.any(Number),
      expect.any(Number),
      null,
      [],
    );
    // No prefill to watch for, so the unmounted tab's output never streams into the webview.
    expect(ptySpawnMock).not.toHaveBeenCalled();
    // The start command is still gated behind the launch delay.
    expect(ptyWriteMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(ptyWriteMock).toHaveBeenCalledWith("tab-1", "opencode\r");
  });

  it("spawns with the env of the accounts the harness is bound to", async () => {
    accountsLaunchEnvMock.mockResolvedValueOnce({ env: [["CLAUDE_CONFIG_DIR", "/h/1"]] });
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]));
    expect(accountsLaunchEnvMock).toHaveBeenCalledWith("wt-1", "test", "tab-1");
    expect(ptySpawnDetachedMock).toHaveBeenCalledWith(
      "tab-1",
      "wt-1",
      "/cwd",
      expect.any(Number),
      expect.any(Number),
      null,
      [["CLAUDE_CONFIG_DIR", "/h/1"]],
    );
  });

  it("launches with the default login when the account env is unavailable", async () => {
    accountsLaunchEnvMock.mockRejectedValueOnce(new Error("host down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await startBackgroundAgentSession("tab-1", "wt-1", "/cwd", agent(["claude"]));
    expect(ptySpawnDetachedMock.mock.calls[0]?.[6]).toEqual([]);
    warn.mockRestore();
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
