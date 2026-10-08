import { describe, expect, it } from "vitest";

import { toAgentView } from "./agent-view";

describe("toAgentView", () => {
  it("keeps the two known surfaces", () => {
    expect(toAgentView("chat")).toBe("chat");
    expect(toAgentView("terminal")).toBe("terminal");
  });

  it("falls back to chat for anything else", () => {
    expect(toAgentView("")).toBe("chat");
    expect(toAgentView("scratchpad")).toBe("chat");
  });
});
