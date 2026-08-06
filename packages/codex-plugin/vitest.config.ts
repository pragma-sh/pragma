import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `test/report.test.ts` drives the real `hooks/report.sh` through `sh`, and
    // several cases invoke it repeatedly, then wait on a background watcher.
    // Under `turbo run test` every package's suite runs at once, so a shell
    // spawn that takes ~100ms alone can take seconds — the subagent and
    // transcript-question cases then blow vitest's 5s default with no assertion
    // error. Match the headroom the sibling hook bridges already give theirs.
    testTimeout: 30_000,
  },
});
