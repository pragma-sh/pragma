import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "react/jsx-runtime": "@pragma/plugin/jsx-runtime",
      "react-dom": "@pragma/plugin/react-dom",
      react: "@pragma/plugin/react",
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
