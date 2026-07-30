import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Vitest project for the benchmark tier (`*.bench.ts`).
 *
 * Separate from `vitest.config.ts` so `bun run test` never picks these up: they
 * measure rather than assert, they take far longer than a unit test, and a
 * benchmark that ran on every test invocation would be deleted within a week.
 * They live here rather than in `packages/bench` because the policy they measure
 * — the renderer cache, the wheel gate, tab retention — only does anything with
 * jsdom and a mocked `@xterm/addon-webgl`, both of which this project already
 * configures. Run them with `bun run bench`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    include: ["src/**/*.bench.ts"],
    // One file, one process: these measure wall time, and workers competing for
    // cores would add noise the audit cannot distinguish from a regression.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
