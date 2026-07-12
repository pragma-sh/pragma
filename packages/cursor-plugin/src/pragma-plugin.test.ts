import { expect, it, vi } from "vitest";

import { cursorAgentPlugin } from "./pragma-plugin";

it("submits interjections in a separate PTY write", async () => {
  const watcher = cursorAgentPlugin.watchers?.[0];
  expect(watcher).toBeDefined();

  const controller = new AbortController();
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
                  agent: "cursor",
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
      },
    },
    agentId: "cursor",
    config: undefined,
    session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
    output: (async function* () {})(),
    sendKeys,
    reportMessage: async () => {},
    signal: controller.signal,
  };

  await watcher?.watch(context as never);

  expect(sendKeys).toHaveBeenNthCalledWith(1, "continue");
  expect(sendKeys).toHaveBeenNthCalledWith(2, "\r");
});
