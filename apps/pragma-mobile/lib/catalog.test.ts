import { describe, expect, it } from "vitest";

import { catalogToSelectorAgents } from "./catalog";

describe("catalogToSelectorAgents", () => {
  it("preserves every host model and its reasoning levels", () => {
    const agents = catalogToSelectorAgents([
      {
        id: "cursor",
        name: "Cursor Agent",
        pluginId: "pragma.cursor",
        launch: { commands: [] },
        models: [
          { id: "gpt-5.6", name: "GPT-5.6", reasoning: [{ id: "high", name: "High" }] },
          { id: "sonnet", name: "Sonnet" },
        ],
      },
    ]);

    expect(agents).toEqual([
      {
        id: "cursor",
        name: "Cursor Agent",
        icon: "◆",
        models: [
          { id: "gpt-5.6", name: "GPT-5.6", reasoning: [{ id: "high", name: "High" }] },
          { id: "sonnet", name: "Sonnet", reasoning: [] },
        ],
      },
    ]);
  });
});
