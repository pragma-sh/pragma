import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installMemoryLocalStorage } from "@/test/storage";
import {
  promptHistoryLabel,
  promptHistorySummary,
  readPromptHistory,
  recordPromptHistory,
} from "./worktree-prompt-history";

const base = {
  mode: "single" as const,
  branch: "feature",
  title: "",
  prompt: "Do the thing.",
  agents: [{ agentId: "claude", selection: { modelId: null, reasoningId: null } }],
};

describe("worktree prompt history", () => {
  beforeAll(installMemoryLocalStorage);
  afterEach(() => window.localStorage.clear());

  it("records runs per project, newest first", () => {
    recordPromptHistory("p", { ...base, branch: "one" });
    recordPromptHistory("p", { ...base, branch: "two" });
    recordPromptHistory("q", { ...base, branch: "other" });

    expect(readPromptHistory("p").map((entry) => entry.branch)).toEqual(["two", "one"]);
    expect(readPromptHistory("q")).toHaveLength(1);
  });

  it("keeps a bounded number of entries", () => {
    for (let index = 0; index < 40; index += 1) {
      recordPromptHistory("p", { ...base, branch: `b${index}` });
    }
    const entries = readPromptHistory("p");
    expect(entries).toHaveLength(30);
    expect(entries[0]!.branch).toBe("b39");
  });

  it("reads corrupt storage as empty", () => {
    window.localStorage.setItem("pragma:worktree-prompt-history:p", "{not json");
    expect(readPromptHistory("p")).toEqual([]);
  });

  it("labels an entry by title, then branch", () => {
    recordPromptHistory("p", { ...base, title: "Token refresh" });
    recordPromptHistory("p", base);
    const [untitled, titled] = readPromptHistory("p");
    expect(promptHistoryLabel(titled!)).toBe("Token refresh");
    expect(promptHistoryLabel(untitled!)).toBe("feature");
  });

  it("summarizes a prompt by its first sentence", () => {
    recordPromptHistory("p", {
      ...base,
      prompt: "Add token\nrefresh to v1.2 auth. Then write tests!",
    });
    expect(promptHistorySummary(readPromptHistory("p")[0]!)).toBe(
      "Add token refresh to v1.2 auth.",
    );
  });
});
