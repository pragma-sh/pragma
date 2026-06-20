# Configuration

Plannar config — fields, custom component bindings, and CSS overrides. Config is **not** scaffolded by `plannar init`; create it only when you need to override defaults.

**Contents**

- [Configuration](#configuration)
  - [Resolution \& sources](#resolution--sources)
  - [Fields](#fields)
  - [Custom component bindings (`meta`)](#custom-component-bindings-meta)
  - [CSS overrides](#css-overrides)

## Resolution & sources

Plannar resolves config merged **local > global > defaults**. JS/TS configs load via `jiti`; JSON is parsed directly. Both sources are optional.

| Source | Path                                            |
| ------ | ----------------------------------------------- |
| Global | `~/.config/plannar/plannar.config.{js,ts,json}` |
| Local  | `./plannar.config.{js,ts,json}` (CWD)           |

## Fields

| Field           | Type                           | Default              | Description                                                  |
| --------------- | ------------------------------ | -------------------- | ------------------------------------------------------------ |
| `plannarFolder` | `string`                       | `".plannar"`         | Root folder for plans, components, and config                |
| `exportsFolder` | `string`                       | `".plannar/exports"` | Output directory for exported HTML                           |
| `globalCss`     | `string?`                      | _none_               | CSS that overrides builtin styles                            |
| `cssFilePath`   | `string?`                      | _none_               | Additional CSS loaded alongside `globalCss`                  |
| `meta`          | `Record<string, BindingMeta>?` | _none_               | Custom component bindings merged with built-in registrations |
| `viteConfig`    | `object?`                      | _none_               | Deep-merged Vite overrides: `{ editor?: {}, exports?: {} }`  |

`exportsFolder` derives from `plannarFolder` unless set explicitly. If `plannarFolder` is `.my-plans`, `exportsFolder` becomes `.my-plans/exports`.

## Custom component bindings (`meta`)

The `meta` field registers custom component bindings so user components support the `bind` prop in Playground blocks (see `references/jsx.md` for the `bind` system). Each entry maps a component name to a `BindingMeta` object with `valueProp`, `changeProp`, `extract`, and optional `inject`:

```js
// plannar.config.js
export default {
  meta: {
    "my-input": {
      valueProp: "value",
      changeProp: "onValueChange",
      extract: "e",
    },
  },
};
```

## CSS overrides

Builtin styles come from `theme.css` (shadcn tokens, fonts, reset, dark mode) and `mdx.css` (headings, code blocks, tables — scoped under `.mdx-content` with `:where()` for zero specificity). Your CSS loads **after** both, in this order:

1. Builtin `mdx.css` → 2. Builtin `theme.css` → 3. Your `globalCss` → 4. Your `cssFilePath`

`globalCss` is for overriding builtins (no default — set via `plannar.config`). `cssFilePath` is supplemental (no default, must be explicit).

Override theme tokens on `:root` / `.dark`:

```css
:root {
  --primary: oklch(0.55 0.2 250);
  --radius: 0.5rem;
}
.dark {
  --background: oklch(0.15 0.02 250);
}
```

Override MDX content via `.mdx-content`:

```css
.mdx-content h1 {
  font-size: 2.5rem;
}
.mdx-content a {
  color: var(--primary);
  text-decoration: underline;
}
```

In the editor, CSS loads via `virtual:plannar-global-css` (a Vite virtual module). In exports, files are copied to a temp directory and `@import`-ed in the generated `index.css`. Both paths produce the same load order.
