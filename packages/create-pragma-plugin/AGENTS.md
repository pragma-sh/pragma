# packages/create-pragma-plugin — Plugin Scaffolder

Scaffolds a pure-TypeScript Pragma plugin project. The generated template
stays aligned with `@pragma-sh/plugin` and the host loader contract.

## Publishing

This CLI is published to npm (`npm create pragma-plugin`), as is the
`@pragma-sh/plugin` it scaffolds against. Both go out from the `publish-packages`
job in `.github/workflows/release.yml` — see the root `AGENTS.md`.

The scaffolded project's `@pragma-sh/plugin` range is **never a literal** — it comes
from this package's own `version`, which Release Please keeps equal to
`@pragma-sh/plugin`'s through the linked `desktop` group, and bunup bakes in at build
time. A hardcoded value scaffolds a dependency on a version that was never
published; `src/scaffold.test.ts` asserts against the real one.

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
  `scope-foo`. A monorepo-internal plugin that should be `@pragma-sh/…` must be
  renamed in its generated `package.json` after scaffolding (this is what
  `@pragma-sh/dev-test-plugin` did).
- `--force` overwrites a non-empty destination.

## Generated template contract

- Generated plugins build to a single self-contained ESM bundle and set
  `package.json` `main` to that bundle (`./dist/index.js`, via `vite build`).
- The bundler config externalizes/delegates React by aliasing `react`,
  `react-dom`, and `react/jsx-runtime` to `@pragma-sh/plugin/react`,
  `@pragma-sh/plugin/react-dom`, and `@pragma-sh/plugin/jsx-runtime`.
- The generated `tsconfig.json` uses `jsxImportSource: "react"` (NOT
  `@pragma-sh/plugin`): the `@pragma-sh/plugin` jsx-runtime shim re-exports
  `jsx`/`jsxs`/`Fragment` but not a JSX namespace, so intrinsic elements
  would not type-check against the shim. The vite alias still redirects
  `react/jsx-runtime` → `@pragma-sh/plugin/jsx-runtime` at build time, so the
  bundle never bundles React.
- README output shows adding `{ "path": "./my-plugin" }` to
  `.pragma/config.json` and includes the local-code trust note.
- Package-manager detection is deterministic and testable; it does not shell
  out unless needed.

## Rules

- Keep `src/templates.ts` as the single source for generated file contents.
- When `@pragma-sh/plugin` gains a new contribution type, surface it through a
  new `ScaffoldCapability` and template branch here.

## Commands

```bash
bun run --filter create-pragma-plugin typecheck
bun run --filter create-pragma-plugin test
bun run --filter create-pragma-plugin build
```
