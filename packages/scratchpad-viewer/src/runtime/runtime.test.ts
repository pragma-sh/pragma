// @vitest-environment jsdom
/**
 * Smoke test for the bundled runtime: it is the one part of this package that
 * cannot be checked by reading it, since it only exists after the build. jsdom
 * has no layout, so hit-testing is stubbed; everything else is the real script
 * a phone runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VIEWER_RUNTIME_SCRIPT } from "../generated/runtime-script";
import type { ScratchpadViewerMessage } from "../messages";

const posted: ScratchpadViewerMessage[] = [];

function boot(source: string): void {
  document.body.innerHTML = '<div id="root"></div>';
  posted.length = 0;
  Object.assign(globalThis, {
    pragmaScratchpadSource: source,
    pragmaScratchpadComments: [],
  });
  Object.defineProperty(window, "ReactNativeWebView", {
    configurable: true,
    value: {
      postMessage: (message: string) => posted.push(JSON.parse(message) as ScratchpadViewerMessage),
    },
  });
  new Function(VIEWER_RUNTIME_SCRIPT)();
}

/** Waits for MDX evaluation, the React commit, and the rAF that indexes blocks. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling the async render.
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (posted.some((message) => message.type === "ready")) return;
  }
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

describe("scratchpad viewer runtime", () => {
  it("renders markdown and reports its height", async () => {
    boot("---\npragmaScratchpad: {}\n---\n\n# The plan\n\nShip it.\n");

    await settle();

    expect(document.getElementById("root")?.textContent).toContain("The plan");
    expect(posted.at(-1)).toMatchObject({ type: "ready" });
  });

  it("selects the tapped block, quote included, only in comment mode", async () => {
    boot("# The plan\n\nShip it.\n");
    await settle();
    const block = document.querySelectorAll("#root > *")[1];
    document.elementFromPoint = () => block as Element;

    document.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1 }));
    expect(posted.some((message) => message.type === "select")).toBe(false);

    window.pragmaScratchpadViewer?.receive(JSON.stringify({ type: "commentMode", active: true }));
    document.dispatchEvent(new MouseEvent("click", { clientX: 1, clientY: 1 }));

    expect(posted.at(-1)).toEqual({ type: "select", block: { index: 1, quote: "Ship it." } });
    expect(block?.classList.contains("pragma-viewer-selected")).toBe(true);
  });

  it("highlights blocks that already carry an unresolved comment", async () => {
    boot("# The plan\n\nShip it.\n");
    await settle();

    window.pragmaScratchpadViewer?.receive(
      JSON.stringify({
        type: "comments",
        comments: [
          {
            id: "a",
            from: 0,
            to: 0,
            quote: "Ship it.",
            text: "why",
            createdAt: 1,
            resolvedAt: null,
            blockIndex: 1,
          },
        ],
      }),
    );

    const blocks = document.querySelectorAll("#root > *");
    expect(blocks[1]?.classList.contains("pragma-viewer-commented")).toBe(true);
    expect(blocks[0]?.classList.contains("pragma-viewer-commented")).toBe(false);
  });

  it("renders a nested component that imports React hooks", async () => {
    // The import is stripped before evaluation, so `useState` has to resolve
    // from the page's global scope — without that this died with
    // "Can't find variable: useState".
    boot(
      [
        'import { useState } from "react";',
        "",
        "export function Counter() {",
        "  const [count] = useState(7);",
        "  return <p>count {count}</p>;",
        "}",
        "",
        "<Counter />",
      ].join("\n"),
    );

    await settle();

    expect(document.getElementById("root")?.textContent).toContain("count 7");
    expect(posted.filter((message) => message.type === "error")).toEqual([]);
  });

  it("renders a component the scratchpad library ships without importing it", async () => {
    boot('<AskQuestion question="Ship it?" type="yes-no" />\n');

    await settle();

    expect(document.getElementById("root")?.textContent).toContain("Ship it?");
    expect(posted.filter((message) => message.type === "error")).toEqual([]);
  });

  it("reports an unrenderable document instead of blanking", async () => {
    boot("<Nope />\n");

    await settle();

    expect(posted.some((message) => message.type === "error")).toBe(true);
  });
});
