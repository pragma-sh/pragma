import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runProjectScripts = vi.fn(async () => true);

vi.mock("@/lib/tauri", () => ({
  runProjectScripts: (...args: unknown[]) => runProjectScripts(...(args as [])),
}));

import { markProjectAdded, PROJECT_SWITCH_SETTLE_MS } from "@/lib/project-scripts";
import { useProjectSwitchScripts } from "@/hooks/use-project-switch-scripts";

function render(initial: string | null) {
  return renderHook(({ id }: { id: string | null }) => useProjectSwitchScripts(id), {
    initialProps: { id: initial },
  });
}

describe("useProjectSwitchScripts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runProjectScripts.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not treat restoring the first project as a switch", () => {
    const hook = render(null);
    hook.rerender({ id: "a" });
    act(() => vi.advanceTimersByTime(PROJECT_SWITCH_SETTLE_MS));

    expect(runProjectScripts).not.toHaveBeenCalled();
  });

  it("runs once for the project the selection settles on, naming the one it left", () => {
    const hook = render("a");
    hook.rerender({ id: "b" });
    hook.rerender({ id: "c" });
    act(() => vi.advanceTimersByTime(PROJECT_SWITCH_SETTLE_MS));

    expect(runProjectScripts).toHaveBeenCalledTimes(1);
    expect(runProjectScripts).toHaveBeenCalledWith("c", "switch", "a");
  });

  it("runs nothing when the selection comes back before settling", () => {
    const hook = render("a");
    hook.rerender({ id: "b" });
    hook.rerender({ id: "a" });
    act(() => vi.advanceTimersByTime(PROJECT_SWITCH_SETTLE_MS));

    expect(runProjectScripts).not.toHaveBeenCalled();
  });

  it("skips landing on a project that was just added", () => {
    const hook = render("a");
    markProjectAdded("new");
    hook.rerender({ id: "new" });
    act(() => vi.advanceTimersByTime(PROJECT_SWITCH_SETTLE_MS));
    expect(runProjectScripts).not.toHaveBeenCalled();

    // The next move away is an ordinary switch from the new project.
    hook.rerender({ id: "a" });
    act(() => vi.advanceTimersByTime(PROJECT_SWITCH_SETTLE_MS));
    expect(runProjectScripts).toHaveBeenCalledWith("a", "switch", "new");
  });
});
