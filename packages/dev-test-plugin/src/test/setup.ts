import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { createBridge, setBridge } from "./bridge";

// `@pragma/plugin/ui` and `@pragma/plugin/jsx-runtime` call `getBridge()` at
// module-load time, so a bridge must be installed before any plugin module is
// imported. Vitest runs setupFiles before importing the test files, so install
// a default bridge at the top level here.
setBridge(createBridge());

beforeEach(() => {
  setBridge(createBridge());
});

afterEach(() => {
  cleanup();
});
