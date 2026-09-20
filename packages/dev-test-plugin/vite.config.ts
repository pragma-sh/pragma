import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "react/jsx-runtime": "@pragma-sh/plugin/jsx-runtime",
      "react-dom": "@pragma-sh/plugin/react-dom",
      react: "@pragma-sh/plugin/react",
    },
  },
  build: {
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
