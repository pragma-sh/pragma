import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getViewedProjectRoot,
  setViewedProjectRoot,
  subscribeViewedProject,
} from "./viewed-project";

afterEach(() => {
  setViewedProjectRoot(null);
});

describe("viewed-project store", () => {
  it("starts on the global theme", () => {
    expect(getViewedProjectRoot()).toBeNull();
  });

  it("notifies subscribers only when the root actually changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeViewedProject(listener);

    setViewedProjectRoot("/repo/main");
    setViewedProjectRoot("/repo/main");
    expect(getViewedProjectRoot()).toBe("/repo/main");
    expect(listener).toHaveBeenCalledTimes(1);

    setViewedProjectRoot(null);
    expect(getViewedProjectRoot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setViewedProjectRoot("/other/main");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
