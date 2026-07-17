/// <reference types="vitest/config" />
import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri injects this when running `tauri dev` on a physical device / LAN.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/ — tuned for Tauri (fixed port, no clear screen).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // CodeMirror validates extensions with `instanceof`. Bun's isolated linker
    // and Rolldown can otherwise expose separate direct/transitive state copies.
    dedupe: ["@codemirror/state"],
  },
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Tauri owns the Rust side; don't let Vite watch it.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
