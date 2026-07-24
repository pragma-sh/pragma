import { describe, expect, it, vi } from "vitest";

import { parsePiModels, piAgentPlugin } from "./pragma-plugin";

describe("pi watcher", () => {
  it("submits interjections and clears status on session exit", async () => {
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

    expect(sendKeys).toHaveBeenCalledWith("continue\r");
    expect(report).toHaveBeenCalledWith({
      agent: "pi",
      tabId: "tab-1",
      worktreeId: "worktree-1",
      status: "cleared",
      attentionKind: null,
    });
  });
});

describe("parsePiModels", () => {
  it("checks Node managers when the plugin host PATH omits Pi", async () => {
    const run = vi.fn(async () => [{ stdout: "", stderr: "", status: 0 }]);
    const models = piAgentPlugin.agents?.[0]?.models;

    expect(typeof models).toBe("function");
    if (typeof models === "function") {
      await models({ sdk: { exec: { run } } } as never);
    }

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.stringMatching(
            /fnm exec --using default -- pi --list-models.*"\$HOME\/\.bun\/bin\/pi" --list-models/,
          ),
        ],
      }),
    );
  });

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
