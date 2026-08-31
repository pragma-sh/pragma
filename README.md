# pragma

Pragma is a terminal designed to run many agents in parallel.

A Bun + Turborepo monorepo with a Tauri (macOS/Linux) desktop app built on Vite +
React + TypeScript and a Rust backend, sharing constants across the language boundary.

## Quick start

```bash
bun install                          # install everything
bun run dev                          # run the desktop app (native window)
bun run check                        # lint + format + typecheck + clippy
```

Requires: [Bun](https://bun.sh), a Rust toolchain (clippy + rustfmt), and the Tauri
system prerequisites (https://v2.tauri.app/start/prerequisites/).

## Layout

- `apps/pragma` — the Tauri desktop app (`src/` React frontend, `src-tauri/` Rust).
- `packages/constants` — shared constants (TS + Rust) from one JSON source of truth.

## Contributing

Read **[AGENTS.md](./AGENTS.md)** — it documents the architecture, code standards, and
workflows for both humans and AI agents (`CLAUDE.md` is a symlink to it). User-facing skill
sources live in `skills/` and link into `.agents/skills`; internal skills live directly in
`.agents/skills` (exposed through `.claude/skills`).
