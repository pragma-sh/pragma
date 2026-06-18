# Components, elements & bindings (JSX layer)

Everything that goes inside a plan's MDX as JSX: shadcn/ui components, raw HTML elements, the `bind` prop, and Playground. For MDX document rules (gotchas, layout, prose), see `references/mdx.md`.

**Contents**

- [Components, elements \& bindings (JSX layer)](#components-elements--bindings-jsx-layer)
  - [Adding shadcn components](#adding-shadcn-components)
  - [Prefer components over markdown](#prefer-components-over-markdown)
  - [Layout components](#layout-components)
  - [HTML elements](#html-elements)
  - [The `bind` prop \& supported elements](#the-bind-prop--supported-elements)
  - [Playground](#playground)

## Adding shadcn components

Shadcn/ui is set up in `.plannar` (config in `.plannar/components.json` — see `references/structure.md`). Add a component with the user's preferred package manager:

```sh
npx shadcn@latest add accordion
```

Full registry: https://ui.shadcn.com/r

The `button` scaffolded by `plannar init` installs automatically; anything else you reach for, add with the command above. Newly added components and their external imports are written to `.plannar/package.json` so the plan renders.

## Prefer components over markdown

Use real components rather than the markdown equivalent — they render richer and stay consistent with the plan's styling. This is not just for interactive UI; **non-interactive components matter just as much** for making a plan skimmable:

- Tables → shadcn **Table**, not a markdown `| ... |` table.
- Callouts / summaries → **Card** or **Alert**, not blockquotes.
- Labels / tags → **Badge**.
- Section breaks → **Separator**.

Interactive components are encouraged where they aid review (Tabs, Accordion, Playground controls), but reach for the non-interactive ones (Table, Card, Alert, Badge, Separator) routinely.

## Layout components

When to reach for each:

- **Tabs** — parallel options the reader chooses between: approach A vs B, "what" vs "why", frontend vs backend.
- **Accordion** — supporting detail most readers skip: derivations, edge-case notes, long rationale.
- **Card** — discrete summary blocks: goals, risks, affected files, checklists.
- **Table** — structured comparisons and field/option lists.
- **Controls** (Checkbox, Switch, Slider, Select) — used _around_ a Playground preview, never as the prototype itself.

## HTML elements

Plain HTML elements work directly in MDX (`<input>`, `<textarea>`, `<select>`, `<div>`, etc.), styled with Tailwind. Several support the `bind` prop (see the table below). Mind the JSX rules from `references/mdx.md` (`className`, self-closing void tags).

## The `bind` prop & supported elements

Inside a Playground, the `bind` prop auto-wires React state — no hooks needed. **Registered elements** auto-wire value + change handlers:

| Element                                                                                | Type   | Datatype   |
| -------------------------------------------------------------------------------------- | ------ | ---------- |
| `<input>` / `<textarea>`                                                               | HTML   | `string`   |
| `<input type="checkbox">`                                                              | HTML   | `boolean`  |
| `<input type="number">`                                                                | HTML   | `number`   |
| `<select>`                                                                             | HTML   | `string`   |
| `Checkbox` / `Switch`                                                                  | shadcn | `boolean`  |
| `Slider`                                                                               | shadcn | `number[]` |
| `Select` / `Tabs` / `Accordion`                                                        | shadcn | `string`   |
| `Dialog` / `Sheet` / `Drawer` / `Popover` / `Tooltip` / `DropdownMenu` / `Collapsible` | shadcn | `boolean`  |

**Unregistered elements** (e.g. `<Button>`) still get the state variable plus a `setXxx` setter you wire manually:

```jsx
<Button bind="count:0" onClick={() => setCount(count + 1)}>
  Clicks: {count}
</Button>
```

Custom project components are registered via the `meta` field in `plannar.config` so they support `bind` too — see `references/config.md`.

## Playground

Use `<Playground>` to embed an interactive UI preview.

**Syntax:**

- `bind="name"` → state starts as `undefined`
- `bind="name:value"` → explicit initial value (`count:0`, `text:'Hello'`)
- Each Playground is its own scope; duplicate bind names within one Playground error out; nested Playgrounds get independent scopes.

**Example — slider drives a preview:**

```jsx
<Playground>
  <Slider bind="radius:12" min={0} max={64} />
  <div style={{ borderRadius: `${radius}px` }} className="p-6 bg-blue-500 text-white text-center">
    {radius}px radius
  </div>
</Playground>
```

**Rules:**

- **Don't use shadcn components for the prototype itself.** If the plan proposes a card, build it with HTML + Tailwind. Shadcn is for the _controls_ around the prototype (a slider for border radius, etc.).
- **Don't wire previews to real APIs.** A "current location" mock stays mocked.
- **Don't reuse `.plannar` shadcn components in the actual implementation** — those are plan-only.
- **Use Tailwind** for styling unless dynamic values force inline styles.
