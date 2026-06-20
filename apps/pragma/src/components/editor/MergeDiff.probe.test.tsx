import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { type DiffComment, MergeDiff } from "./MergeDiff";

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button onClick={() => setN((v) => v + 1)} type="button">
      count {n}
    </button>
  );
}

const makeComments = (): DiffComment[] => [{ key: "t1", line: 1, content: <Counter /> }];

describe("MergeDiff widget portal state", () => {
  it("preserves portal child local state when the comments array identity changes", async () => {
    // A new `comments` array identity must NOT remount the widget's React child:
    // the card's local UI state (collapsed/resolving) has to survive a re-render
    // (and, in a real browser, MergeView's height-measure redraw cycle). The fix
    // keeps the MergeView alive and updates comment decorations via a StateField,
    // so CodeMirror reuses the widget DOM (stable portal container) by key.
    const { rerender } = render(
      <div style={{ height: 400 }}>
        <MergeDiff comments={makeComments()} newText={"a\nb\n"} oldText={"a\n"} />
      </div>,
    );
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(await screen.findByText(/count 0/));
    expect(screen.getByText(/count 1/)).toBeInTheDocument();

    // New comments array identity -> decorations are re-dispatched, but the
    // widget (keyed "t1") is reused, so the portal child is not remounted.
    rerender(
      <div style={{ height: 400 }}>
        <MergeDiff comments={makeComments()} newText={"a\nb\n"} oldText={"a\n"} />
      </div>,
    );
    await new Promise((r) => setTimeout(r, 0));
    // State is preserved: the widget DOM (portal container) was reused.
    expect(screen.getByText(/count 1/)).toBeInTheDocument();
  });
});
