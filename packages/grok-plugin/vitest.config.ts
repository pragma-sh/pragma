import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `test/report.test.ts` drives the real `hooks/report.sh` through `sh`, and
    // several cases invoke it three times, then wait on a background watcher.
    // Spawning a shell costs ~0.5-2.6s on Windows (Git Bash, process creation,
    // no fork), so those cases land close to vitest's 5s default and fail
    // intermittently with no assertion error. Give the work real headroom.
    testTimeout: 30_000,
  },
});
