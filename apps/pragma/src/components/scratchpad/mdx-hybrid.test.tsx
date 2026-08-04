import { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getMarkdown } from "@/components/editor/tiptap-markdown";

import { nestedMarkdownRegion, preprocessMdxForTiptap } from "./mdx-hybrid";
import { MdxJsxContainer, MdxRenderedBlock } from "./mdx-hybrid";
import { scratchpadMarkdownExtensions } from "./scratchpad-extensions";

describe("preprocessMdxForTiptap", () => {
  it("keeps markdown editable and preserves MDX regions exactly", () => {
    const source = `# Editable

import { AskQuestion } from "@pragma/scratchpad/ui"

<AskQuestion question="Choose">

  **Nested markdown**

</AskQuestion>
`;
    const prepared = preprocessMdxForTiptap(source);
    expect(prepared).toContain("# Editable");
    const rawBlocks = [...prepared.matchAll(/data-source="([^"]+)"/g)].map((match) =>
      decodeURIComponent(match[1] ?? ""),
    );
    expect(rawBlocks).toEqual(['import { AskQuestion } from "@pragma/scratchpad/ui"']);
    const opens = [...prepared.matchAll(/data-open="([^"]+)"/g)].map((match) =>
      decodeURIComponent(match[1] ?? ""),
    );
    expect(opens).toContain('<AskQuestion question="Choose">');
    const closes = [...prepared.matchAll(/data-close="([^"]+)"/g)].map((match) =>
      decodeURIComponent(match[1] ?? ""),
    );
    expect(closes).toContain("</AskQuestion>");
    const contents = [...prepared.matchAll(/data-content="([^"]+)"/g)].map((match) =>
      decodeURIComponent(match[1] ?? ""),
    );
    expect(contents).toContain("<p><strong>Nested markdown</strong></p>");
  });

  it("makes a paragraph containing inline JSX opaque", () => {
    const source = "Before <Badge>status</Badge> after";
    const prepared = preprocessMdxForTiptap(source);
    const encoded = /data-source="([^"]+)"/.exec(prepared)?.[1];
    expect(decodeURIComponent(encoded ?? "")).toBe(source);
    expect(prepared).not.toContain("pragma-mdx-container");
  });

  it("keeps JSX elements holding expressions opaque with their ESM context", () => {
    const source = `export const label = "Ready"

<Badge>{label}</Badge>`;
    const prepared = preprocessMdxForTiptap(source);
    expect(prepared).toContain('data-kind="mdxjsEsm"');
    expect(prepared).toContain('data-kind="mdxJsxFlowElement"');
    expect(prepared).not.toContain("pragma-mdx-container");
    expect(decodeURIComponent(/data-context="([^"]+)"/.exec(prepared)?.[1] ?? "")).toBe(
      'export const label = "Ready"',
    );
  });
});

describe("nestedMarkdownRegion", () => {
  it("locates pure markdown nested inside a JSX flow element", () => {
    const raw = `<AskQuestion question="Choose">

**Nested markdown**

- one
- two

</AskQuestion>`;
    const region = nestedMarkdownRegion(raw);
    expect(region).not.toBeNull();
    expect(raw.slice(region?.start ?? 0, region?.end ?? 0)).toBe(
      "**Nested markdown**\n\n- one\n- two",
    );
    expect(raw.slice(0, region?.start ?? 0).trim()).toBe('<AskQuestion question="Choose">');
    expect(raw.slice(region?.end ?? 0).trim()).toBe("</AskQuestion>");
  });

  it("locates markdown nested inside plain HTML elements", () => {
    const raw = `<div>

Some *details* here.

</div>`;
    const region = nestedMarkdownRegion(raw);
    expect(region).not.toBeNull();
    expect(raw.slice(region?.start ?? 0, region?.end ?? 0)).toBe("Some *details* here.");
  });

  it("rejects elements whose children contain expressions or nested JSX", () => {
    expect(nestedMarkdownRegion(`<Badge>{label}</Badge>`)).toBeNull();
    expect(
      nestedMarkdownRegion(`<Card>

<Inner />

</Card>`),
    ).toBeNull();
  });

  it("rejects empty and self-closing elements", () => {
    expect(nestedMarkdownRegion("<Card />")).toBeNull();
    expect(nestedMarkdownRegion("<Card>\n\n</Card>")).toBeNull();
  });

  it("rejects paragraphs with inline JSX and multi-block raw", () => {
    expect(nestedMarkdownRegion("Before <Badge>status</Badge> after")).toBeNull();
    expect(nestedMarkdownRegion("<Card>\n\ntext\n\n</Card>\n\n# After")).toBeNull();
  });
});

function createEditor(source: string): Editor {
  return new Editor({
    content: preprocessMdxForTiptap(source),
    element: document.createElement("div"),
    extensions: [...scratchpadMarkdownExtensions(), MdxJsxContainer, MdxRenderedBlock],
  });
}

describe("MdxJsxContainer editor round-trip", () => {
  it("parses nested markdown as editable content and serializes the tags back", () => {
    const source = `<AskQuestion question="Choose">

**Nested markdown**

- one
- two

</AskQuestion>`;
    const editor = createEditor(`# Before\n\n${source}`);
    const container = editor.state.doc.childCount > 1 ? editor.state.doc.child(1) : null;
    expect(container?.type.name).toBe("mdxJsxContainer");
    expect(container?.child(0).type.name).toBe("paragraph");
    expect(container?.child(1).type.name).toBe("bulletList");
    const serialized = getMarkdown(editor);
    expect(serialized.trim()).toBe(`# Before

${source}`);
    editor.destroy();
  });

  it("reflects edits to the nested markdown in the serialized source", () => {
    const editor = createEditor(`<div>

Some *details* here.

</div>`);
    const container = editor.state.doc.firstChild;
    expect(container?.type.name).toBe("mdxJsxContainer");
    const from = 2; // inside the container's paragraph
    editor.commands.insertContentAt(from, "Edited. ");
    const serialized = getMarkdown(editor);
    expect(serialized).toContain("<div>");
    expect(serialized).toContain("</div>");
    expect(serialized).toContain("Edited. Some *details* here.");
    editor.destroy();
  });

  it("keeps opaque MDX atoms byte-identical through the round-trip", () => {
    const source = `export const label = "Ready"

<Badge>{label}</Badge>`;
    const editor = createEditor(source);
    expect(getMarkdown(editor).trim()).toBe(source);
    editor.destroy();
  });
});

describe("nested HTML elements", () => {
  it("nests containers so markdown stays editable at every depth", () => {
    const source = `<article>

<section>

<div>

### A heading three levels deep

</div>

</section>

</article>`;
    const editor = createEditor(source);
    const outer = editor.state.doc.firstChild;
    const middle = outer?.firstChild;
    const inner = middle?.firstChild;
    expect(outer?.type.name).toBe("mdxJsxContainer");
    expect(middle?.type.name).toBe("mdxJsxContainer");
    expect(inner?.type.name).toBe("mdxJsxContainer");
    expect(inner?.firstChild?.type.name).toBe("heading");
    expect(getMarkdown(editor).trim()).toBe(source);
    editor.destroy();
  });

  it("edits the innermost markdown of a nested element", () => {
    const editor = createEditor(`<section>

<div>

Deep text.

</div>

</section>`);
    editor.commands.insertContentAt(3, "Edited. ");
    expect(getMarkdown(editor)).toContain("Edited. Deep text.");
    editor.destroy();
  });

  it("keeps an element holding inline JSX opaque inside its parent container", () => {
    const source = `<details>

<summary>Click me</summary>

Body text.

</details>`;
    const editor = createEditor(source);
    const container = editor.state.doc.firstChild;
    expect(container?.type.name).toBe("mdxJsxContainer");
    expect(container?.child(0).type.name).toBe("mdxRenderedBlock");
    expect(container?.child(1).type.name).toBe("paragraph");
    expect(getMarkdown(editor).trim()).toBe(source);
    editor.destroy();
  });

  it("leaves a list editable when only one item carries an element", () => {
    const source = `- First item

- Second item:

  <aside>

  A callout with **strong text**.

  </aside>

- Third item`;
    const editor = createEditor(source);
    const list = editor.state.doc.firstChild;
    expect(list?.type.name).toBe("bulletList");
    expect(list?.childCount).toBe(3);
    expect(list?.child(1).child(1).type.name).toBe("mdxJsxContainer");
    expect(getMarkdown(editor).trim()).toBe(source);
    editor.destroy();
  });

  it("keeps a component with nested JSX opaque so it still renders whole", () => {
    const source = `<Card>

<Badge>Ready</Badge>

</Card>`;
    const editor = createEditor(source);
    expect(editor.state.doc.firstChild?.type.name).toBe("mdxRenderedBlock");
    expect(getMarkdown(editor).trim()).toBe(source);
    editor.destroy();
  });

  it("preserves task list checkboxes nested inside an element", () => {
    const editor = createEditor(`<div>

- [x] Done
- [ ] Pending

</div>`);
    const serialized = getMarkdown(editor);
    expect(serialized).toContain("- [x] Done");
    expect(serialized).toContain("- [ ] Pending");
    editor.destroy();
  });
});

/** Mounts the real React node views, which only render under `EditorContent`. */
function NodeViewHarness({ source }: { source: string }) {
  const editor = useEditor({
    content: preprocessMdxForTiptap(source),
    extensions: [...scratchpadMarkdownExtensions(), MdxJsxContainer, MdxRenderedBlock],
  });
  return <EditorContent editor={editor} />;
}

describe("MdxJsxContainer node view", () => {
  it("renders an editable content host at every nesting level", async () => {
    const { container } = render(
      <NodeViewHarness
        source={`<section>

<div>

Deep text.

</div>

</section>`}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const views = container.querySelectorAll(".node-mdxJsxContainer");
    expect(views).toHaveLength(2);
    const inner = views[1];
    expect(inner?.querySelector("[data-node-view-content]")?.textContent).toBe("Deep text.");
    expect(inner?.closest("[data-node-view-content]")).not.toBeNull();
  });
});
