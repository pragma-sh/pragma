import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // `theme-tokens.ts` reads the shipped color defaults out of `index.css`
    // (`?raw`). Vitest stubs CSS imports to `""` unless processing is enabled,
    // which would leave the token catalog empty under test.
    css: true,
  },
});
