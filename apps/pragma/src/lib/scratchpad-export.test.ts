/// <reference types="node" />
import { buildScratchpadExportHtml } from "@pragma-sh/scratchpad-viewer";
import { describe, expect, it, vi } from "vitest";

// Exercise the real plugin graph with native esbuild; wasm needs a browser worker.
vi.mock("esbuild-wasm", async () => {
  // jsdom's Uint8Array is a different realm from Node's TextEncoder output.
  const { TextEncoder } = await import("node:util");
  vi.stubGlobal(
    "TextEncoder",
    class extends TextEncoder {
      override encode(value?: string): Uint8Array<ArrayBuffer> {
        return new Uint8Array(super.encode(value));
      }
    },
  );
  const esbuild = await import("esbuild");
  return { build: esbuild.build, initialize: vi.fn() };
});

const files = new Map([
  [
    "components/counter.tsx",
    `import { useState } from "react";
    import "./counter.css";
    export default function Counter() { const [n,set]=useState(0); return <button id="counter" onClick={()=>set(n+1)}>count {n}</button>; }`,
  ],
  ["components/counter.css", 'button{background-image:url("../assets/dot.svg")}'],
]);

// Native esbuild anchors resolveDir to cwd; browser wasm anchors it to `/`.
function fixturePath(path: string): string {
  return path.replaceAll(`${process.cwd().replace(/^\//, "")}/`, "");
}

vi.mock("@/lib/tauri", () => ({
  pathExists: vi.fn(async (_worktree: string, path: string) => files.has(fixturePath(path))),
  readFile: vi.fn(async (_worktree: string, path: string) => {
    const text = files.get(fixturePath(path));
    if (text === undefined) throw new Error("File missing");
    return { text, binary: false, truncated: false };
  }),
  readFileChunk: vi.fn(async (_worktree: string, path: string) => {
    if (fixturePath(path) !== "assets/dot.svg") throw new Error(`Asset missing: ${path}`);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    return { base64: btoa(svg), byteSize: svg.length, eof: true };
  }),
}));

import { buildScratchpadPreview } from "./mdx-preview";

describe("scratchpad export bundling", () => {
  it("bundles a local React component, stylesheet and image into a working standalone document", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Exports must not fetch an SDK"));
    const source = [
      'import Counter from "../../components/counter";',
      'import { AskQuestion } from "@pragma-sh/scratchpad/ui";',
      'import { PragmaClient as DirectClient } from "@pragma-sh/sdk";',
      'import { PragmaClient as ReexportedClient } from "@pragma-sh/scratchpad";',
      'import { PragmaClient as CdnClient } from "https://esm.sh/@pragma-sh/sdk@1.1.0";',
      'export const stubCalls = Promise.all([new DirectClient().rpc("exec", {}), new ReexportedClient().agents.reportInput({text:"feedback"}), new CdnClient().rpc("exec", {})]).then(() => { globalThis.exportSdkStubbed = true; });',
      "",
      "# Offline plan",
      "",
      "![Dot](../../assets/dot.svg)",
      "",
      "<Counter />",
      "",
      '<AskQuestion question="Proceed?" type="yes-no" />',
    ].join("\n");
    const bundle = await buildScratchpadPreview({
      source,
      filePath: ".pragma/scratchpads/plan.mdx",
      worktreeId: "wt",
      standalone: true,
    });
    expect(bundle.css).toContain("data:image/svg+xml");
    const html = buildScratchpadExportHtml({
      ...bundle,
      title: "Plan",
      mode: "light",
      themeCss: "",
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.innerHTML = '<div id="root"></div>';
    for (const script of parsed.querySelectorAll("script"))
      new Function(script.textContent ?? "")();
    await vi.waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Offline plan"));
    expect(document.querySelector("img")?.src).toMatch(/^data:image\/svg\+xml/);
    document.getElementById("counter")?.click();
    await vi.waitFor(() => expect(document.getElementById("counter")?.textContent).toBe("count 1"));
    expect(document.querySelector('input[type="radio"]')?.matches(":disabled")).toBe(false);
    expect((globalThis as unknown as { exportSdkStubbed?: boolean }).exportSdkStubbed).toBe(true);
    expect(parsed.querySelector("script[src],link[href]")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
