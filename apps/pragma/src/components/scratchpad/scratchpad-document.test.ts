import { describe, expect, it } from "vitest";

import {
  attachScratchpadAgent,
  parseScratchpadDocument,
  replaceScratchpadBody,
  scratchpadCommentsPath,
} from "./scratchpad-document";

const source = `---
pragmaScratchpad: {"version":1,"id":"scratch-1","title":"Demo","agentTabId":"tab-1","agentId":"plugin.agent","createdAt":1}
custom: kept
---
# Hello
`;

describe("scratchpad document", () => {
  it("requires and parses managed frontmatter", () => {
    const document = parseScratchpadDocument(source);
    expect(document.metadata.title).toBe("Demo");
    expect(document.body).toBe("# Hello\n");
    expect(() => parseScratchpadDocument("# unmanaged")).toThrow("not a managed");
  });

  it("preserves frontmatter while replacing body or attachment", () => {
    const document = parseScratchpadDocument(source);
    expect(replaceScratchpadBody(document, "# Changed\n")).toContain(
      "custom: kept\n---\n# Changed",
    );

    const attached = attachScratchpadAgent(source, { tabId: "tab-2", agentId: "plugin.other" });
    const reparsed = parseScratchpadDocument(attached);
    expect(reparsed.metadata.agentTabId).toBe("tab-2");
    expect(reparsed.metadata.agentId).toBe("plugin.other");
    expect(reparsed.body).toBe("# Hello\n");
  });

  it("uses a sibling JSON comment path", () => {
    expect(scratchpadCommentsPath(".pragma/scratchpads/demo.mdx")).toBe(
      ".pragma/scratchpads/demo.mdx.comments.json",
    );
  });
});
