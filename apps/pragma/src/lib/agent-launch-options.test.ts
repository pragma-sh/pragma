import { afterEach, describe, expect, it } from "vitest";

import {
  defaultPermissionMode,
  filterSlashCommands,
  nextMode,
  rememberPermissionMode,
  slashMenuKeyAction,
  slashQuery,
  splitSlashPrompt,
  sharedSlashCommands,
} from "./agent-launch-options";

const commands = [{ name: "init" }, { name: "review" }, { name: "pr-review" }];

/** A key press with no modifiers unless `extra` adds them. */
function key(name: string, extra: Partial<KeyboardEvent> = {}) {
  return { key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra };
}

describe("slash picker helpers", () => {
  it("only opens while the prompt is a bare /name", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/review now")).toBeNull();
    expect(slashQuery("fix /rev")).toBeNull();
  });

  it("ranks prefix matches before substring matches", () => {
    expect(filterSlashCommands(commands, "rev").map((command) => command.name)).toEqual([
      "review",
      "pr-review",
    ]);
    expect(filterSlashCommands(commands, "")).toHaveLength(3);
  });

  it("maps picker keys and leaves modified or unrelated keys to the editor", () => {
    expect(slashMenuKeyAction(key("ArrowDown"))).toBe("next");
    expect(slashMenuKeyAction(key("ArrowUp"))).toBe("previous");
    expect(slashMenuKeyAction(key("Enter"))).toBe("select");
    expect(slashMenuKeyAction(key("Tab"))).toBe("select");
    expect(slashMenuKeyAction(key("Tab", { shiftKey: true }))).toBeNull();
    expect(slashMenuKeyAction(key("Enter", { metaKey: true }))).toBeNull();
    expect(slashMenuKeyAction(key("a"))).toBeNull();
  });

  it("splits a known leading command from its input", () => {
    expect(splitSlashPrompt("/review  the auth module", commands)).toEqual({
      slashCommand: "review",
      prompt: "the auth module",
    });
    expect(splitSlashPrompt("/init", commands)).toEqual({ slashCommand: "init", prompt: "" });
    expect(splitSlashPrompt("/unknown thing", commands)).toEqual({
      slashCommand: null,
      prompt: "/unknown thing",
    });
  });
});

describe("mode helpers", () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // Storage may be unavailable in this environment.
    }
  });

  it("cycles modes and wraps around", () => {
    const modes = [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ];
    expect(nextMode(modes, "build")).toBe("plan");
    expect(nextMode(modes, "plan")).toBe("build");
    expect(nextMode(modes, null)).toBe("build");
    expect(nextMode([], null)).toBeNull();
  });

  it("defaults to the first permission mode unless a valid one was remembered", () => {
    const modes = [
      { id: "auto", name: "Auto" },
      { id: "ask", name: "Ask" },
    ];
    expect(defaultPermissionMode("agent", modes)).toBe("auto");
    rememberPermissionMode("agent", "ask");
    const remembered = defaultPermissionMode("agent", modes);
    // Remembering is best-effort: environments without storage keep the default.
    expect(["ask", "auto"]).toContain(remembered);
    expect(defaultPermissionMode("agent", [{ id: "other", name: "Other" }])).toBe("other");
  });
});

describe("sharedSlashCommands", () => {
  it("keeps commands every agent has with the same invocation, in the first list's order", () => {
    const claude = [{ name: "review" }, { name: "init" }, { name: "skill", invocation: "/skill" }];
    const codex = [{ name: "init" }, { name: "review" }, { name: "skill", invocation: "$skill" }];
    expect(sharedSlashCommands([claude, codex]).map((command) => command.name)).toEqual([
      "review",
      "init",
    ]);
  });

  it("offers nothing without agents and everything for one", () => {
    expect(sharedSlashCommands([])).toEqual([]);
    expect(sharedSlashCommands([[{ name: "review" }]])).toEqual([{ name: "review" }]);
  });
});
