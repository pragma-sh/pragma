import { describe, expect, it, vi } from "vitest";

import { parsePiModels, piAgentPlugin } from "./pragma-plugin";

describe("pi watcher", () => {
  it("submits interjections without reporting cleared on session exit", async () => {
    const watcher = piAgentPlugin.watchers?.[0];
    expect(watcher).toBeDefined();

    const controller = new AbortController();
    const report = vi.fn(async () => {});
    const sendKeys = vi.fn(async () => {});
    const context = {
      sdk: {
        agents: {
          connect: async () => ({
            async *[Symbol.asyncIterator]() {
              try {
                yield {
                  type: "agentInput",
                  input: {
                    agent: "pi",
                    worktreeId: "worktree-1",
                    tabId: "tab-1",
                    text: "continue",
                  },
                };
              } finally {
                controller.abort();
              }
            },
          }),
          report,
        },
      },
      agentId: "pi",
      config: undefined,
      session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
      output: (async function* () {})(),
      sendKeys,
      reportMessage: async () => {},
      signal: controller.signal,
    };

    await watcher?.watch(context as never);

    // Interjection is typed and submitted, but the watcher never emits its own
    // `cleared` on exit — that is owned by the Pi extension (session_shutdown /
    // on-load), avoiding a delayed `cleared` racing a relaunched session.
    expect(sendKeys).toHaveBeenCalledWith("continue\r");
    expect(report).not.toHaveBeenCalled();
  });
});

describe("parsePiModels", () => {
  it("parses model rows and thinking support", () => {
    expect(
      parsePiModels(`provider        model             context  max-out  thinking  images
github-copilot  claude-haiku-4.5  200K     64K      yes       yes
github-copilot  gpt-4.1           128K     16.4K    no        yes
invalid row`),
    ).toEqual([
      {
        id: "github-copilot/claude-haiku-4.5",
        name: "claude-haiku-4.5 (github-copilot)",
        reasoning: [
          { id: "off", name: "Off" },
          { id: "minimal", name: "Minimal" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
          { id: "xhigh", name: "Extra High" },
          { id: "max", name: "Max" },
        ],
      },
      {
        id: "github-copilot/gpt-4.1",
        name: "gpt-4.1 (github-copilot)",
      },
    ]);
  });
});
