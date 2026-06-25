import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  browserOpenExternal: vi.fn(async () => {}),
}));

import { GitHubMarkdown } from "./GitHubMarkdown";

describe("GitHubMarkdown", () => {
  it("renders inline HTML that GitHub comments commonly use", () => {
    const { container } = render(
      <GitHubMarkdown>{"<details><summary>more</summary><b>bold</b></details>"}</GitHubMarkdown>,
    );
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("b")?.textContent).toBe("bold");
  });

  it("strips script tags so malicious JavaScript never renders", () => {
    const { container } = render(
      <GitHubMarkdown>{"hello <script>window.__pwned = true;</script>"}</GitHubMarkdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("hello");
  });

  it("strips javascript: links and event handlers", () => {
    const { container } = render(
      <GitHubMarkdown>{'<a href="javascript:alert(1)" onclick="alert(2)">x</a>'}</GitHubMarkdown>,
    );
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toContain("javascript:");
    expect(anchor?.getAttribute("onclick")).toBeNull();
  });
});
