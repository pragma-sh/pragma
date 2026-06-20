# Writing the plan MDX

Rules for the `.mdx` files in `.plannar/plans/` — the only files the agent edits. Plans are **MDX**, not plain markdown: markdown prose plus JSX components. The differences below are where agents most often go wrong.

For the component toolkit (shadcn components, HTML elements, the `bind` prop, and Playground), see `references/jsx.md`.

**Contents**

- [MDX vs plain markdown — gotchas](#mdx-vs-plain-markdown--gotchas)
- [Layout philosophy](#layout-philosophy)
- [Prose & code conventions](#prose--code-conventions)

## MDX vs plain markdown — gotchas

MDX looks like markdown but parses like JSX in places. These are the failure modes to watch for:

### Markdown inside a component needs blank lines

Content packed tightly against a JSX tag is treated as JSX children, **not** markdown — so `**bold**`, lists, and headings won't render. To get markdown to render inside a component, separate it from the opening and closing tags with **blank lines**:

```mdx
<!-- Won't render as markdown — tight against the tags -->

<Card>Goals: ship **fast**, keep it simple.</Card>

<!-- Renders as markdown — blank lines isolate the content -->

<Card>

Goals: ship **fast**, keep it simple.

- Step one
- Step two

</Card>
```

(The comments above are illustrative — see the comment rule below; don't use HTML comments in real plans.)

### Don't over-indent embedded content

Markdown indented **4+ spaces** becomes a code block. When you put a list or paragraph inside a component, keep it at the component's indent (or unindented) so a list inside a `<Card>` doesn't silently turn into a `<pre>` block.

### Comments are JSX, not HTML

`<!-- ... -->` is invalid in MDX and errors the file. Use `{/* ... */}` instead.

### Curly braces open expressions

`{` starts a JavaScript expression. To print a literal brace in prose, wrap it: write `{'{'}` rather than a bare `{`. A stray unescaped `{` errors the whole file.

### It is JSX, so attributes are JSX

`class` → `className`, `for` → `htmlFor`. Inline styles are objects: `style={{ borderRadius: '8px' }}`. Void elements must self-close (`<br />`, not `<br>`), and every tag/component must be closed.

### Separate adjacent blocks

Leave a blank line between a markdown block and a JSX block, and between sibling JSX blocks, so the parser keeps them distinct.

## Layout philosophy

The point of MDX is layout. A plan that's all paragraphs has failed the format. Don't write walls of text — reach for the component toolkit in `references/jsx.md`:

- **Tabs** — compare approaches, separate "what" from "why", split frontend/backend.
- **Accordion** — long supporting detail most readers can skip.
- **Card** — summary blocks: goals, risks, affected files, checklist.
- **Playground** — interactive previews of UI being proposed.

Also prefer real components over their markdown equivalents — e.g. a shadcn **Table** instead of a markdown `| ... |` table. See `references/jsx.md`.

## Prose & code conventions

- Keep prose tight. Use lists.
- Put paths in `code`.
- Use `file.ts:42` for line references.
