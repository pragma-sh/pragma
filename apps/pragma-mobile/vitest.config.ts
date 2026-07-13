import { defineConfig } from "vitest/config";

// Pure-logic unit tests only (transcript store, pairing, workspace mapping,
// launch form). RN/Expo screens are verified manually in the dev client, so the
// node environment and a narrow include keep these tests device-free and fast.
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
