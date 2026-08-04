import { lazy, Suspense } from "react";

import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const ScratchpadPreview = lazy(() =>
  import("@/components/scratchpad/ScratchpadPreview").then((module) => ({
    default: module.ScratchpadPreview,
  })),
);

interface PositionedNode {
  type: string;
  /** JSX tag name; `null` for a fragment, absent for every non-JSX node. */
  name?: string | null;
  children?: PositionedNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

/** One source span replaced by TipTap-friendly markup during preprocessing. */
interface SpanRewrite {
  start: number;
  end: number;
  html: string;
}

interface MarkdownSerializerState {
  write(value?: string): void;
  closeBlock(node: ProseMirrorNode): void;
  renderContent(node: ProseMirrorNode): void;
}

interface MdxRenderedBlockOptions {
  filePath: string;
  worktreeId: string;
  getAttachedAgentTabId: () => string | null;
  onRequestAgentAttachment: () => Promise<boolean>;
}

const MDX_NODE_TYPES = new Set([
  "mdxjsEsm",
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
]);

/**
 * Markdown containers whose own text must stay editable when a JSX element sits
 * somewhere inside them: rewriting descends into these instead of atomizing the
 * whole block, so an `<aside>` in one list item cannot freeze the entire list.
 */
const RECURSIVE_MARKDOWN_TYPES = new Set(["blockquote", "list", "listItem"]);

/**
 * Replaces MDX regions with TipTap-friendly markup, at every depth. A region
 * holding expressions or inline JSX becomes a lossless `<pragma-mdx-block>`
 * atom; a JSX element wrapping editable content becomes a
 * `<pragma-mdx-container>` whose children stay ordinary document content — and
 * those children may be containers themselves, so nesting stays editable all
 * the way down.
 */
export function preprocessMdxForTiptap(source: string): string {
  const root = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkGfm)
    .parse(source) as PositionedNode;
  const context = (root.children ?? [])
    .filter((node) => node.type === "mdxjsEsm")
    .map((node) => sourceForNode(source, node))
    .join("\n\n");
  return rewriteChildren(source, root, context, 0, source.length);
}

/** A source span of editable markdown inside an MDX block's raw text. */
export interface MarkdownRegion {
  start: number;
  end: number;
}

/**
 * Locates the editable children of a single JSX flow element, as offsets into
 * `raw`. Returns null when the element cannot hold editable content — it is
 * empty, it is not exactly one flow element, or it is a component whose
 * children hold MDX (a component only renders correctly as a whole, so it stays
 * an opaque live-preview atom; a plain HTML tag provides no React context and is
 * always split).
 */
export function nestedMarkdownRegion(raw: string): MarkdownRegion | null {
  const root = parseMdx(raw);
  const children = root?.children ?? [];
  if (children.length !== 1) return null;
  const element = children[0];
  if (!element || element.type !== "mdxJsxFlowElement" || !isEditableElement(element)) return null;
  const elementStart = element.position?.start.offset;
  const region = childRegion(element);
  if (elementStart === undefined || !region) return null;
  return { start: region.start - elementStart, end: region.end - elementStart };
}

/**
 * Rewrites every MDX span inside `node`'s children, returning the `[from, to)`
 * slice of `source` with those spans replaced. Line indentation at each span is
 * carried onto the replacement so a rewrite inside a list item stays in it.
 */
function rewriteChildren(
  source: string,
  node: PositionedNode,
  context: string,
  from: number,
  to: number,
): string {
  let cursor = from;
  let output = "";
  for (const rewrite of collectRewrites(source, node, context)) {
    output += source.slice(cursor, rewrite.start);
    output += `\n${indentAt(source, rewrite.start)}${rewrite.html}\n`;
    cursor = rewrite.end;
  }
  return output + source.slice(cursor, to);
}

/** Span replacements for one node's children, in source order. */
function collectRewrites(
  source: string,
  node: PositionedNode,
  context: string,
): readonly SpanRewrite[] {
  const rewrites: SpanRewrite[] = [];
  for (const child of node.children ?? []) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined || !containsMdx(child)) continue;
    if (RECURSIVE_MARKDOWN_TYPES.has(child.type)) {
      rewrites.push(...collectRewrites(source, child, context));
      continue;
    }
    rewrites.push({ start, end, html: nodeHtml(source, child, context) });
  }
  return rewrites;
}

/** Markup for one MDX node: an editable container, or an opaque atom. */
function nodeHtml(source: string, node: PositionedNode, context: string): string {
  const region =
    node.type === "mdxJsxFlowElement" && isEditableElement(node) ? childRegion(node) : null;
  if (!region) return blockHtml(sourceForNode(source, node), context, node.type);
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? source.length;
  const open = source.slice(start, region.start).trim();
  const close = source.slice(region.end, end).trim();
  const content = markdownToHtml(rewriteChildren(source, node, context, region.start, region.end));
  return containerHtml(open, close, content);
}

/**
 * Whether a JSX flow element's children can be edited in place. Components
 * (capitalized or member expressions) must render as a whole, so they only
 * split when their children are pure markdown; a plain HTML tag renders nothing
 * of its own and always splits, with any MDX inside it becoming its own atom.
 */
function isEditableElement(element: PositionedNode): boolean {
  const inner = element.children ?? [];
  if (inner.length === 0) return false;
  if (isComponentName(element.name)) return !inner.some(containsMdx);
  return true;
}

/** True for a JSX name React resolves to a component rather than an HTML tag. */
function isComponentName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^[A-Z]/.test(name) || name.includes(".");
}

/** Absolute source span covering a JSX element's children. */
function childRegion(element: PositionedNode): MarkdownRegion | null {
  const inner = element.children ?? [];
  const start = inner[0]?.position?.start.offset;
  const end = inner.at(-1)?.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}

/** Leading whitespace of the line `offset` sits on, or "" when it has content. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const prefix = source.slice(lineStart, offset);
  return /^\s*$/.test(prefix) ? prefix : "";
}

function parseMdx(source: string): PositionedNode | null {
  try {
    return unified().use(remarkParse).use(remarkMdx).use(remarkGfm).parse(source) as PositionedNode;
  } catch {
    return null;
  }
}

/** TipTap atom preserving MDX bytes while rendering JSX as a live sandboxed component. */
export const MdxRenderedBlock = Node.create<MdxRenderedBlockOptions>({
  name: "mdxRenderedBlock",
  group: "block",
  atom: true,
  isolating: true,
  selectable: true,

  addOptions() {
    return {
      filePath: "scratchpad.mdx",
      worktreeId: "",
      getAttachedAgentTabId: () => null,
      onRequestAgentAttachment: () => Promise.resolve(false),
    };
  },

  addAttributes() {
    return {
      raw: { default: "" },
      context: { default: "" },
      kind: { default: "mdx" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "pragma-mdx-block",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const encoded = element.dataset.source;
          if (!encoded) return false;
          return {
            raw: decodeURIComponent(encoded),
            context: decodeURIComponent(element.dataset.context ?? ""),
            kind: element.dataset.kind ?? "mdx",
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "pragma-mdx-block",
      mergeAttributes(HTMLAttributes, {
        "data-context": encodeURIComponent(String(node.attrs.context)),
        "data-kind": String(node.attrs.kind),
        "data-source": encodeURIComponent(String(node.attrs.raw)),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MdxRenderedBlockView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          state.write(String(node.attrs.raw));
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/**
 * A JSX element whose children are pure markdown. The open/close tags are kept
 * as attributes so serialization stays lossless, while the markdown inside is
 * ordinary editable document content.
 */
export const MdxJsxContainer = Node.create({
  name: "mdxJsxContainer",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: { default: "" },
      close: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "pragma-mdx-container",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const open = decodeAttribute(element.dataset.open);
          const close = decodeAttribute(element.dataset.close);
          if (!open || !close) return false;
          return { open, close };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "pragma-mdx-container",
      mergeAttributes(HTMLAttributes, {
        "data-open": encodeURIComponent(String(node.attrs.open)),
        "data-close": encodeURIComponent(String(node.attrs.close)),
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MdxJsxContainerView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          state.write(String(node.attrs.open));
          state.closeBlock(node);
          state.renderContent(node);
          state.write(String(node.attrs.close));
          state.closeBlock(node);
        },
        parse: {
          // The preprocessed document carries inner markdown as rendered HTML in
          // `data-content`; decode it into real children before ProseMirror
          // parses. Decoding one level can reveal the next, so this repeats
          // until no encoded container is left.
          updateDOM(element: HTMLElement) {
            let pending = element.querySelectorAll("pragma-mdx-container[data-content]");
            while (pending.length > 0) {
              for (const container of pending) {
                const encoded = container.getAttribute("data-content");
                container.innerHTML = encoded ? decodeURIComponent(encoded) : "";
                container.removeAttribute("data-content");
              }
              pending = element.querySelectorAll("pragma-mdx-container[data-content]");
            }
          },
        },
      },
    };
  },
});

function MdxRenderedBlockView({ extension, node, selected }: ReactNodeViewProps) {
  const { raw, context, kind } = node.attrs as {
    raw: string;
    context: string;
    kind: string;
  };
  if (kind === "mdxjsEsm") {
    return <NodeViewWrapper className="hidden" />;
  }
  const options = extension.options as MdxRenderedBlockOptions;
  const source = context ? `${context}\n\n${raw}` : raw;
  return (
    <NodeViewWrapper
      className={
        selected
          ? "not-prose my-3 overflow-hidden rounded-md ring-1 ring-primary"
          : "not-prose my-3 overflow-hidden rounded-md"
      }
      contentEditable={false}
      data-mdx-rendered="true"
    >
      <Suspense
        fallback={
          <div className="grid min-h-20 place-items-center text-xs text-muted-foreground">
            Rendering component...
          </div>
        }
      >
        <ScratchpadPreview
          filePath={options.filePath}
          getAttachedAgentTabId={options.getAttachedAgentTabId}
          onRequestAgentAttachment={options.onRequestAgentAttachment}
          source={source}
          worktreeId={options.worktreeId}
        />
      </Suspense>
    </NodeViewWrapper>
  );
}

function MdxJsxContainerView({ node }: ReactNodeViewProps) {
  const { open, close } = node.attrs as { open: string; close: string };
  // The element is invisible in the editor: no frame, and no tag chips either —
  // nesting is recursive, so both stack into chrome that reads as literal text
  // in the prose. The tags live on the node's attributes and are written back
  // on serialization, so the source stays lossless; `title` keeps them
  // discoverable on hover for anyone who needs to know what wraps a block.
  return (
    <NodeViewWrapper title={`${open}${close}`}>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

function blockHtml(raw: string, context: string, kind: string): string {
  return `<pragma-mdx-block data-context="${escapeAttribute(encodeURIComponent(context))}" data-kind="${kind}" data-source="${escapeAttribute(encodeURIComponent(raw))}"></pragma-mdx-block>`;
}

function containerHtml(open: string, close: string, content: string): string {
  return (
    `<pragma-mdx-container data-open="${escapeAttribute(encodeURIComponent(open))}" ` +
    `data-close="${escapeAttribute(encodeURIComponent(close))}" ` +
    `data-content="${escapeAttribute(encodeURIComponent(content))}"></pragma-mdx-container>`
  );
}

/**
 * Renders a container's children to HTML. Raw HTML passes through untouched
 * because the children may already hold the markup of a nested container or
 * atom, produced by the rewrite that runs before this.
 */
function markdownToHtml(markdown: string): string {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeTaskLists)
      .use(rehypeStringify, { allowDangerousHtml: true })
      .processSync(markdown),
  );
}

/** Minimal hast element shape; only what the task-list rewrite touches. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Rewrites GFM's task-list markup into the shape `@tiptap/extension-list`
 * parses (`ul[data-type=taskList]` / `li[data-type=taskItem]`). Without this a
 * checklist nested inside a container loses its checkboxes on the way in and
 * serializes back out as a plain bullet list.
 */
function rehypeTaskLists(): (tree: HastNode) => void {
  const visit = (node: HastNode): void => {
    if (hasClass(node, "contains-task-list")) {
      node.properties = {
        ...node.properties,
        className: undefined,
        "data-type": "taskList",
        "data-tight": "true",
      };
    }
    if (hasClass(node, "task-list-item")) {
      const box = (node.children ?? []).find(
        (child) => child.tagName === "input" && child.properties?.type === "checkbox",
      );
      node.properties = {
        ...node.properties,
        className: undefined,
        "data-type": "taskItem",
        "data-checked": String(box?.properties?.checked === true),
      };
      node.children = (node.children ?? []).filter((child) => child !== box);
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

function hasClass(node: HastNode, name: string): boolean {
  const className = node.properties?.className;
  return Array.isArray(className) && className.includes(name);
}

function containsMdx(node: PositionedNode): boolean {
  if (MDX_NODE_TYPES.has(node.type)) return true;
  return node.children?.some(containsMdx) ?? false;
}

function sourceForNode(source: string, node: PositionedNode): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

function decodeAttribute(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
