# Pragma Dev Test Plugin

A Pragma plugin scaffolded with `create-pragma-plugin`.

## Quick Start

```bash
bun install
bun run build
```

## Load In Pragma

Add this to your project's `.pragma/config.json`:

```json
{
  "plugins": [{ "path": "./dev-test-plugin" }]
}
```

Pragma loads local plugin code from this path. Only add plugins you trust.

## Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
```
