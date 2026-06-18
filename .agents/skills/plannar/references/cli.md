# Plannar CLI

The complete Plannar command set.

**Contents**

- [Plannar CLI](#plannar-cli)
  - [`plannar init`](#plannar-init)
  - [`plannar editor`](#plannar-editor)
  - [`plannar status`](#plannar-status)
  - [`plannar inspect`](#plannar-inspect)
  - [`plannar install-skills`](#plannar-install-skills)

## `plannar init`

Scaffolds `.plannar/` (see `references/structure.md` for what each scaffolded file is).

After scaffolding, it:

1. Runs `npx shadcn@latest add button`.
2. Scans the generated files for external imports and writes them to `package.json` dependencies.
3. Runs `npm install` so the sample plan works immediately.
4. Prompts to install the plannar agent skill via `plannar install-skills` (ensuring the latest version from git). The prompt is skipped when stdin is not a TTY (e.g. CI).

Config is **not** scaffolded into `.plannar/`. Users who need custom config create a `plannar.config.{js,ts,json}` at their project root — see `references/config.md`.

## `plannar editor`

Starts the plan editor dev server with HMR. Resolves project config and sets env vars for Vite.

- `--port` (default `5173`)
- `--host` (default `localhost`)

Deep-merges optional `viteConfig.editor` overrides from JS/TS config files.

## `plannar status`

Checks whether the editor is running and reports which editors are for this project vs others. Scans from the given port (default `5173`) across the next 10 ports, and verifies each server is the plannar editor (not a random Vite app) by checking for the `plannar-editor` meta tag.

- Respects `--port` / `--host`; also reads `viteConfig.editor.server` from JS/TS configs.
- Compares each running editor's plannar root (embedded via a `plannar-root` meta tag) against the current project's resolved plannar folder.
- If an editor matches this project, prints its URL with a success message. Otherwise prints "No editor running for this project" and lists any other editors found under an "Other projects:" heading.

## `plannar inspect`

Inspects a running plan editor for compilation errors via HTTP. Run this after writing a plan to confirm it compiles.

- `--port` (optional) — the editor port. **Omit it to target the current project's editor automatically.**
- `--host` (default `localhost`).
- `--plan` (optional) — plan slug to check, e.g. `hello-world`. When given, fetches the plan's compiled module; otherwise checks the main entry module.

Reads `viteConfig.editor.server` from config for host/https overrides. Prints errors to stdout. **Exits `1` if errors are found, `0` otherwise.**

```sh
# verify a specific plan in the current project
plannar inspect --plan my-feature
```

## `plannar install-skills`

Installs plannar agent skills from the git remote into `.agents` or `.claude` directories. Always fetches the latest version from `https://github.com/ethan-krich/plannar`. Copies the entire skill folder — including subdirectories like `references/` — so all skill resources are available locally.

```sh
plannar install-skills [skill...] [--local] [--global] [--agent general|claude|both] [--symlink]
```

**Options:**

- `[skill...]` — Skill names to install. Omit to install all available skills.
- `--local` — Install in the current project directory.
- `--global` — Install in the user home directory (default when non-TTY).
- `--agent` — Agent type: `general` (`.agents/`), `claude` (`.claude/`), or `both`.
- `--symlink` — When installing to both agents, symlink from `.agents/` to `.claude/` instead of copying.

**Interactive prompts (TTY only):** when flags aren't provided, uses arrow-key select prompts for location and agent, and a confirm prompt for symlink:

1. Arrow-key select: install location (global / local).
2. Arrow-key select: agent type (general `.agents` / claude `.claude` / both).
3. If both agents: confirm prompt to symlink from `.agents/` to `.claude/`.

**Examples:**

```sh
# Interactive mode (TTY)
plannar install-skills

# Install specific skills globally for the general agent
plannar install-skills plannar --global --agent general

# Install multiple skills locally for both agents with symlink
plannar install-skills plannar changesets --local --agent both --symlink

# Install for claude only
plannar install-skills plannar --agent claude
```
