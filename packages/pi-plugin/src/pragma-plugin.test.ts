import { describe, expect, it } from "vitest";

import { parsePiModels } from "./pragma-plugin";

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
