import { describe, expect, it } from "vitest";

import { attachedAgentTab, attachmentLabel, lastSegment } from "./scratchpad-agent";
import type { AgentTab } from "./types";

const tab = (overrides: Partial<AgentTab> = {}): AgentTab => ({
  id: "tab-1",
  worktreeId: "wt-1",
  agent: "claude",
  title: "Claude",
  status: "running",
  attentionKind: null,
  ...overrides,
});

describe("scratchpad agent attachment", () => {
  it("resolves the attached tab only while it is still open", () => {
    expect(attachedAgentTab({ agentTabId: "tab-1" }, [tab()])?.title).toBe("Claude");
    expect(attachedAgentTab({ agentTabId: "tab-9" }, [tab()])).toBeNull();
    expect(attachedAgentTab({ agentTabId: null }, [tab()])).toBeNull();
  });

  it("labels the three attachment states", () => {
    expect(attachmentLabel({ agentTabId: "tab-1", agentId: "pragma.claude" }, [tab()])).toBe(
      "Claude",
    );
    expect(attachmentLabel({ agentTabId: "tab-9", agentId: "pragma.claude" }, [tab()])).toBe(
      "claude · not running",
    );
    expect(attachmentLabel({ agentTabId: null, agentId: null }, [])).toBe("No agent attached");
  });

  it("reduces a catalog id to the runtime id the stream is keyed by", () => {
    expect(lastSegment("my-plugin.opencode")).toBe("opencode");
    expect(lastSegment("opencode")).toBe("opencode");
  });
});
