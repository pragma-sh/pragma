import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";

import {
  clearEditorLocation,
  requestEditorLocation,
  useEditorLocation,
} from "./editor-location-store";

it("delivers and clears one-shot editor locations", () => {
  const { result } = renderHook(() => useEditorLocation("tab"));
  act(() => requestEditorLocation("tab", 4, 2));
  expect(result.current).toMatchObject({ line: 4, column: 2 });
  const generation = result.current?.generation ?? 0;
  act(() => clearEditorLocation("tab", generation));
  expect(result.current).toBeNull();
});
