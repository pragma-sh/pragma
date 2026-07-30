import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import type { PluginRecord } from "./registry";

const { gatewayConnectionInfo, startPluginWatcher } = vi.hoisted(() => ({
  gatewayConnectionInfo: vi.fn(),
  startPluginWatcher: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gatewayConnectionInfo,
  startPluginWatcher,
}));

function record(): PluginRecord {
  return {
    pluginId: "plugin-a",
    version: "1.0.0",
    mainPath: "/plugin-a/main.js",
    scope: "global",
    status: "loaded",
    config: { enabled: true },
    definition: {
      name: "Plugin A",
      watchers: [{ agent: "agent", watch: () => undefined }],
      __apiVersion: "1.0.0",
    } as PluginDefinition,
  };
}

const session = {
  agentId: "plugin-a.agent",
  sessionId: "session-1",
  tabId: "tab-1",
  worktreeId: "worktree-1",
};

describe("plugin watcher lifecycle", () => {
  beforeEach(async () => {
    vi.resetModules();
    gatewayConnectionInfo.mockReset();
    gatewayConnectionInfo.mockResolvedValue({ baseUrl: "http://gateway", token: "token" });
    startPluginWatcher.mockReset();
    startPluginWatcher.mockResolvedValue(undefined);
  });

  it("stops existing children before starting from refreshed contributions", async () => {
    let releaseStop: (() => void) | undefined;
    startPluginWatcher.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const watchers = await import("./watchers");

    watchers.setPluginWatchers([record()]);
    const starting = watchers.startWatcherForAgentSession(session);
    await vi.waitFor(() => expect(startPluginWatcher).toHaveBeenCalledTimes(1));
    expect(startPluginWatcher.mock.calls[0]?.[0]).toMatchObject({ operation: "stopAll" });

    releaseStop?.();
    await starting;
    expect(startPluginWatcher.mock.calls[1]?.[0]).toMatchObject({
      operation: "start",
      agentId: "plugin-a.agent",
      watcherAgent: "agent",
      sessionId: "session-1",
    });
  });

  it("lets Rust deduplicate repeated starts", async () => {
    const watchers = await import("./watchers");
    watchers.setPluginWatchers([record()]);
    await vi.waitFor(() => expect(startPluginWatcher).toHaveBeenCalledTimes(1));

    await watchers.startWatcherForAgentSession(session);
    await watchers.startWatcherForAgentSession(session);

    expect(
      startPluginWatcher.mock.calls.filter(([request]) => request.operation === "start"),
    ).toHaveLength(2);
  });

  it("can stop one session or all sessions", async () => {
    const watchers = await import("./watchers");

    await watchers.stopPluginWatchersForSession(session);
    await watchers.stopAllPluginWatchers();

    expect(startPluginWatcher).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: "stop",
        sessionId: "session-1",
        tabId: "tab-1",
        worktreeId: "worktree-1",
      }),
    );
    expect(startPluginWatcher).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: "stopAll" }),
    );
  });
});
