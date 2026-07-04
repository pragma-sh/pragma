# packages/create-pragma-plugin — Plugin Scaffolder

Scaffolds a pure-TypeScript Pragma plugin project. The generated template
stays aligned with `@pragma/plugin` and the host loader contract.

## CLI

The `create-pragma-plugin` CLI is fully non-interactive when flags are passed;
it only prompts on a TTY when `--capabilities` is omitted (and defaults to
`["ui"]` when input isn't a TTY). Run it with bun:

```bash
bun packages/create-pragma-plugin/dist/cli.js <directory> \
  [--name <package-name>] [--pm bun|npm|pnpm|yarn] \
  [--capabilities ui,commands,agents] [--force]
```

- **Name handling:** `normalizePluginName` (see `src/names.ts`) lower-cases and
  strips scope prefixes — `--name @scope/foo` becomes the un-scoped
  `scope-foo`. A monorepo-internal plugin that should be `@pragma/…` must be
  renamed in its generated `package.json` after scaffolding (this is what
  `@pragma/dev-test-plugin` did).
- `--force` overwrites a non-empty destination.

## Generated template contract

- Generated plugins build to a single self-contained ESM bundle and set
  `package.json` `main` to that bundle (`./dist/index.js`, via `vite build`).
- The bundler config externalizes/delegates React by aliasing `react`,
  `react-dom`, and `react/jsx-runtime` to `@pragma/plugin/react`,
  `@pragma/plugin/react-dom`, and `@pragma/plugin/jsx-runtime`.
- The generated `tsconfig.json` uses `jsxImportSource: "react"` (NOT
  `@pragma/plugin`): the `@pragma/plugin` jsx-runtime shim re-exports
  `jsx`/`jsxs`/`Fragment` but not a JSX namespace, so intrinsic elements
  would not type-check against the shim. The vite alias still redirects
  `react/jsx-runtime` → `@pragma/plugin/jsx-runtime` at build time, so the
  bundle never bundles React.
- README output shows adding `{ "path": "./my-plugin" }` to
  `.pragma/config.json` and includes the local-code trust note.
- Package-manager detection is deterministic and testable; it does not shell
  out unless needed.

## Rules

- Keep `src/templates.ts` as the single source for generated file contents.
- When `@pragma/plugin` gains a new contribution type, surface it through a
  new `ScaffoldCapability` and template branch here.

## Commands

```bash
bun run --filter create-pragma-plugin typecheck
bun run --filter create-pragma-plugin test
bun run --filter create-pragma-plugin build
```
