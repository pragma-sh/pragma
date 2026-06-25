import { beforeEach, describe, expect, it } from "vitest";

import { isModelPinned, sortModelsByPin, toggleModelPin } from "./model-pins";

const models = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

function keyFor(agentId: string, modelId: string): string {
  return JSON.stringify([agentId, modelId]);
}

describe("sortModelsByPin", () => {
  it("keeps original order when nothing is pinned", () => {
    expect(sortModelsByPin("agent", models, new Set()).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("floats pinned models to the top, preserving order within each group", () => {
    const pinned = new Set([keyFor("agent", "c"), keyFor("agent", "b")]);
    expect(sortModelsByPin("agent", models, pinned).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("scopes pins by agent id", () => {
    const pinned = new Set([keyFor("other", "a")]);
    expect(sortModelsByPin("agent", models, pinned).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("toggleModelPin", () => {
  beforeEach(() => {
    localStorage.clear();
    if (isModelPinned("agent", "a")) {
      toggleModelPin("agent", "a");
    }
  });

  it("toggles a model pin on and off", () => {
    expect(isModelPinned("agent", "a")).toBe(false);
    toggleModelPin("agent", "a");
    expect(isModelPinned("agent", "a")).toBe(true);
    toggleModelPin("agent", "a");
    expect(isModelPinned("agent", "a")).toBe(false);
  });
});
