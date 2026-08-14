import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";

import { useCollapsiblePanel } from "./use-collapsible-panel";

const options = {
  collapsedKey: "test.panel.collapsed",
  widthKey: "test.panel.width",
  defaultWidth: 300,
  minWidth: 200,
  maxWidth: 500,
  autoCollapseBelow: 1000,
};

function resizeTo(width: number): void {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1400;
});

it("clamps the stored width to the panel's bounds", () => {
  localStorage.setItem(options.widthKey, "9000");
  const { result } = renderHook(() => useCollapsiblePanel(options));
  expect(result.current.width).toBe(options.maxWidth);

  act(() => result.current.setWidth(10));
  expect(result.current.width).toBe(options.minWidth);
  expect(localStorage.getItem(options.widthKey)).toBe(String(options.minWidth));
});

it("collapses on a narrow window and restores the stored choice when it widens", () => {
  const { result } = renderHook(() => useCollapsiblePanel(options));
  expect(result.current.collapsed).toBe(false);

  resizeTo(700);
  expect(result.current.collapsed).toBe(true);
  // The automatic collapse is an overlay: it never rewrites the preference.
  expect(localStorage.getItem(options.collapsedKey)).toBeNull();

  resizeTo(1400);
  expect(result.current.collapsed).toBe(false);
});

it("lets a manual expand outrank the automatic collapse until the width crosses back", () => {
  const { result } = renderHook(() => useCollapsiblePanel(options));
  resizeTo(700);
  expect(result.current.collapsed).toBe(true);

  act(() => result.current.toggleCollapsed());
  expect(result.current.collapsed).toBe(false);

  // Still narrow, so the override holds.
  resizeTo(650);
  expect(result.current.collapsed).toBe(false);

  // Crossing the breakpoint drops the override, so narrowing collapses again.
  resizeTo(1400);
  resizeTo(700);
  expect(result.current.collapsed).toBe(true);
});

it("keeps a hand-collapsed panel collapsed after the window widens", () => {
  const { result } = renderHook(() => useCollapsiblePanel(options));
  act(() => result.current.setCollapsed(true));
  resizeTo(700);
  resizeTo(1400);
  expect(result.current.collapsed).toBe(true);
});
