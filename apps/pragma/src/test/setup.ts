import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Mirror `main.tsx`: register curated brand icons so `<Icon icon="lucide:…" />`
// / `simple-icons:…` resolve synchronously. Without this, Iconify schedules an
// API fetch whose setState callback races jsdom teardown and throws
// `window is not defined` (seen as an unhandled Vitest error on CI).
import "@/lib/brand-icons";

// `globals` is off in vitest.config.ts, so @testing-library/react's
// auto-cleanup (which only registers when it detects a global `afterEach`)
// never runs. Without this, rendered components are never unmounted, so
// their effects keep firing after a test file's jsdom env is torn down.
afterEach(() => {
  cleanup();
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

Range.prototype.getBoundingClientRect ??= () => new DOMRect();
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
