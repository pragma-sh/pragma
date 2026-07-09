import { beforeEach, describe, expect, it, vi } from "vitest";

import { cachedAgentModels, refreshAgentModels } from "./agent-model-cache";
import { resolvePluginAgentModels } from "@/plugins/agents";

vi.mock("@/plugins/agents", () => ({
  resolvePluginAgentModels: vi.fn(),
}));

const resolveMock = vi.mocked(resolvePluginAgentModels);
let nextAgentId = 0;

/** Fresh agent id per test — the module-level cache persists across tests. */
function agentId(): string {
  nextAgentId += 1;
  return `agent-${nextAgentId}`;
}

beforeEach(() => {
  resolveMock.mockReset();
});

describe("refreshAgentModels", () => {
  it("caches a non-empty resolution for the session", async () => {
    const id = agentId();
    resolveMock.mockResolvedValue([{ id: "m", name: "Model", reasoning: [] }]);

    await expect(refreshAgentModels(id)).resolves.toHaveLength(1);
    await expect(refreshAgentModels(id)).resolves.toHaveLength(1);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(cachedAgentModels(id)).toHaveLength(1);
  });

  it("refreshes an expired model list", async () => {
    vi.useFakeTimers();
    const id = agentId();
    resolveMock.mockResolvedValueOnce([{ id: "old", name: "Old", reasoning: [] }]);
    resolveMock.mockResolvedValueOnce([{ id: "new", name: "New", reasoning: [] }]);

    await expect(refreshAgentModels(id)).resolves.toHaveLength(1);
    vi.advanceTimersByTime(5 * 60 * 1000);
    await expect(refreshAgentModels(id)).resolves.toEqual([
      { id: "new", name: "New", reasoning: [] },
    ]);

    expect(resolveMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not cache an empty resolution, so a later call can recover", async () => {
    const id = agentId();
    resolveMock.mockResolvedValueOnce([]);
    resolveMock.mockResolvedValueOnce([{ id: "m", name: "Model", reasoning: [] }]);

    await expect(refreshAgentModels(id)).resolves.toEqual([]);
    expect(cachedAgentModels(id)).toBeUndefined();

    await expect(refreshAgentModels(id)).resolves.toHaveLength(1);
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed resolution (e.g. SDK not connected yet)", async () => {
    const id = agentId();
    resolveMock.mockRejectedValueOnce(new Error("Pragma SDK is not connected yet"));
    resolveMock.mockResolvedValueOnce([{ id: "m", name: "Model", reasoning: [] }]);

    await expect(refreshAgentModels(id)).resolves.toEqual([]);
    expect(cachedAgentModels(id)).toBeUndefined();

    await expect(refreshAgentModels(id)).resolves.toHaveLength(1);
  });

  it("coalesces concurrent lookups into one resolution", async () => {
    const id = agentId();
    resolveMock.mockResolvedValue([{ id: "m", name: "Model", reasoning: [] }]);

    const [first, second] = await Promise.all([refreshAgentModels(id), refreshAgentModels(id)]);

    expect(first).toEqual(second);
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });
});
