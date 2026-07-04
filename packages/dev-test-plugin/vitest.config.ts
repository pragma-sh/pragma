import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest loads this file INSTEAD of vite.config.ts. The plugin's build config
// aliases `react` → `@pragma/plugin/react` (so bundles never bundle React),
// but for component tests we want the real React from node_modules and JSX
// compiled against `react/jsx-runtime` (oxc reads `jsxImportSource` from
// tsconfig, which is set to `"react"`). The `@pragma/plugin` hooks/UI still
// delegate to the bridge installed by `src/test/setup.ts`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
