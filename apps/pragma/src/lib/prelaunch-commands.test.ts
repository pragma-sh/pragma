import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "@pragma-sh/constants";

import type { WorktreeCommandResult } from "@/lib/tauri";

const { runWorktreeCommands, cancelWorktreeCommands, toast } = vi.hoisted(() => ({
  runWorktreeCommands: vi.fn(),
  cancelWorktreeCommands: vi.fn(),
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(() => "warning-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", () => ({ runWorktreeCommands, cancelWorktreeCommands }));
vi.mock("sonner", () => ({ toast }));

import {
  PRELAUNCH_OUTPUT_LIMIT,
  PRELAUNCH_SLOW_WARNING_MS,
  formatPromptWithCommandOutput,
  resolvePromptCommands,
  splitPromptCommands,
  startSessionAfterCommands,
} from "@/lib/prelaunch-commands";

function result(overrides: Partial<WorktreeCommandResult> = {}): WorktreeCommandResult {
  return {
    command: "bun run test",
    stdout: "ok\n",
    stderr: "",
    status: 0,
    durationMs: 1234,
    cancelled: false,
    ...overrides,
  };
}

const TAB = { id: "tab-1", projectId: "p1", worktreeId: "w1" } as Tab;

// These cases mirror `pragma-core/src/prelaunch.rs`; both sides must agree.
describe("splitPromptCommands", () => {
  it("splits inline commands in order, leaving their code spans", () => {
    expect(
      splitPromptCommands(
        "Fix what !!`bun run test` reports, then check !!`git status`.\n\nThanks",
      ),
    ).toEqual({
      prompt: "Fix what `bun run test` reports, then check `git status`.\n\nThanks",
      commands: ["bun run test", "git status"],
    });
  });

  it("keeps a lone command's code span as the prompt", () => {
    expect(splitPromptCommands("!!`ls`")).toEqual({ prompt: "`ls`", commands: ["ls"] });
  });

  it("reads longer fences and strips code-span padding", () => {
    expect(splitPromptCommands("run !!`` echo `hi` `` now")).toEqual({
      prompt: "run `` echo `hi` `` now",
      commands: ["echo `hi`"],
    });
  });

  it("leaves bare bangs, unclosed spans, empty commands, and fences alone", () => {
    const markdown =
      "Wow!! it works\n\n!!`unclosed\n\nempty !!`` `` here\n\n```sh\n!!`inside`\n```";
    expect(splitPromptCommands(markdown)).toEqual({
      prompt: "Wow!! it works\n\n!!`unclosed\n\nempty  here\n\n```sh\n!!`inside`\n```",
      commands: [],
    });
  });
});

describe("resolvePromptCommands", () => {
  beforeEach(() => {
    runWorktreeCommands.mockReset();
  });

  it("returns a prompt without commands unchanged, without running anything", async () => {
    await expect(resolvePromptCommands("w1", "Just text", "Claude")).resolves.toEqual({
      prompt: "Just text",
      warned: false,
    });
    expect(runWorktreeCommands).not.toHaveBeenCalled();
  });

  it("runs only the user's commands and keeps attached context last", async () => {
    runWorktreeCommands.mockResolvedValue([result({ command: "ls", stdout: "a.ts" })]);
    const stored =
      'Fix it with !!`ls`\n\n<context mention="@#1" source="GitHub issues">\n!!`rm -rf /`\n</context>';
    const { prompt } = await resolvePromptCommands("w1", stored, "Claude");
    expect(runWorktreeCommands).toHaveBeenCalledWith("w1", ["ls"], expect.any(String));
    expect(prompt).toMatch(/^Fix it with `ls`\n\nBefore this session started/);
    expect(prompt.indexOf("<command-output")).toBeLessThan(prompt.indexOf("<context"));
    expect(prompt).toContain(
      '<context mention="@#1" source="GitHub issues">\n!!`rm -rf /`\n</context>',
    );
  });
});

describe("formatPromptWithCommandOutput", () => {
  it("returns the prompt unchanged when nothing ran", () => {
    expect(formatPromptWithCommandOutput("Fix it", [])).toBe("Fix it");
  });

  it("appends each command with its exit code, duration, and both streams", () => {
    const prompt = formatPromptWithCommandOutput("Fix the failures", [
      result({ command: 'echo "<hi>"', stdout: "out\n", stderr: "err\n", status: 1 }),
    ]);
    expect(prompt).toBe(
      [
        "Fix the failures",
        "Before this session started, I ran these commands in the worktree. Their output follows.",
        '<command-output command="echo &quot;&lt;hi&gt;&quot;" exit-code="1" duration="1.2s">\nout\n[stderr]\nerr\n</command-output>',
      ].join("\n\n"),
    );
  });

  it("marks skipped commands and still works without a prompt", () => {
    const prompt = formatPromptWithCommandOutput("", [
      result({ command: "sleep 60", stdout: "partial", status: null, cancelled: true }),
      result({ command: "never", stdout: "", status: null, durationMs: 0, cancelled: true }),
    ]);
    expect(prompt.startsWith("Before this session started")).toBe(true);
    expect(prompt).toContain('command="sleep 60" skipped="true"');
    expect(prompt).toContain("partial\n(skipped by the user before it finished");
    expect(prompt).toContain("(skipped by the user; never ran)");
  });

  it("rounds durations half up, exactly like the host's Rust formatter", () => {
    const prompt = formatPromptWithCommandOutput("", [result({ durationMs: 250 })]);
    expect(prompt).toContain('duration="0.3s"');
  });

  it("keeps only the tail of oversized output", () => {
    const stdout = `HEAD${"x".repeat(PRELAUNCH_OUTPUT_LIMIT)}TAIL`;
    const prompt = formatPromptWithCommandOutput("p", [result({ stdout })]);
    expect(prompt).not.toContain("HEAD");
    expect(prompt).toContain("TAIL");
    expect(prompt).toContain("[… 8 earlier characters truncated]");
  });
});

describe("startSessionAfterCommands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runWorktreeCommands.mockReset();
    cancelWorktreeCommands.mockReset().mockResolvedValue(true);
    toast.warning.mockClear();
    toast.success.mockClear();
    toast.error.mockClear();
    toast.dismiss.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the commands, then starts the focused session with their output", async () => {
    runWorktreeCommands.mockResolvedValue([result()]);
    const start = vi.fn().mockResolvedValue(TAB);
    await startSessionAfterCommands({
      worktreeId: "w1",
      agentLabel: "Claude Code",
      commands: ["bun run test"],
      prompt: "Fix it",
      start,
      open: vi.fn(),
    });
    expect(runWorktreeCommands).toHaveBeenCalledWith("w1", ["bun run test"], expect.any(String));
    expect(start).toHaveBeenCalledWith(expect.stringContaining("<command-output"), true);
    expect(start.mock.calls[0]![0]).toMatch(/^Fix it\n\n/);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("warns after 30s with a Skip that cancels the run, then launches in the background", async () => {
    let finish!: (results: WorktreeCommandResult[]) => void;
    runWorktreeCommands.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const start = vi.fn().mockResolvedValue(TAB);
    const open = vi.fn();
    const done = startSessionAfterCommands({
      worktreeId: "w1",
      agentLabel: "Claude Code",
      commands: ["sleep 60"],
      prompt: "",
      start,
      open,
    });

    vi.advanceTimersByTime(PRELAUNCH_SLOW_WARNING_MS - 1);
    expect(toast.warning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    const options = (toast.warning.mock.calls[0] as unknown[])[1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Skip");
    options.action.onClick();
    const runId = runWorktreeCommands.mock.calls[0]![2];
    expect(cancelWorktreeCommands).toHaveBeenCalledWith("w1", runId);

    finish([result({ command: "sleep 60", status: null, cancelled: true })]);
    await done;
    expect(toast.dismiss).toHaveBeenCalledWith("warning-id");
    expect(start).toHaveBeenCalledWith(expect.stringContaining('skipped="true"'), false);
    const success = (toast.success.mock.calls[0] as unknown[])[1] as {
      action: { onClick: () => void };
    };
    success.action.onClick();
    expect(open).toHaveBeenCalledWith(TAB);
  });

  it("reports a failed run as an error toast without starting the agent", async () => {
    runWorktreeCommands.mockRejectedValue(new Error("host unreachable"));
    const start = vi.fn();
    await startSessionAfterCommands({
      worktreeId: "w1",
      agentLabel: "Claude Code",
      commands: ["ls"],
      prompt: "p",
      start,
      open: vi.fn(),
    });
    expect(start).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Could not start Claude Code: host unreachable");
  });
});
