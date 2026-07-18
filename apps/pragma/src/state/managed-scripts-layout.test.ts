import { describe, expect, it, vi } from "vitest";
import type { RefObject, SetStateAction } from "react";

import {
  popScriptLayout,
  type ManagedScriptEntry,
  type ManagedScriptsState,
  type RunScriptsSplitSnapshot,
  type SplitPaneNode,
  type WorkspaceAction,
} from "./workspace-context";

function pane(id: string, tabId: string): SplitPaneNode {
  return { kind: "pane", id, tabIds: [tabId], activeTabId: tabId };
}

function entryFor(
  state: ManagedScriptsState,
  worktreeId: string,
  scriptName: string,
): ManagedScriptEntry {
  const entry = state[worktreeId]?.[scriptName];
  if (!entry) {
    throw new Error(`missing managed script entry for ${worktreeId}/${scriptName}`);
  }
  return entry;
}

/** Applies a React-style functional `setState` update against a fixed prior state. */
function applyUpdate(
  setState: ReturnType<typeof vi.fn>,
  previous: ManagedScriptsState,
): ManagedScriptsState {
  const updater = setState.mock.calls.at(-1)?.[0] as (
    current: ManagedScriptsState,
  ) => ManagedScriptsState;
  return updater(previous);
}

describe("popScriptLayout", () => {
  it("splices a stopped script out of the stack instead of clobbering a still-running script's layout", () => {
    // "run" started first (its snapshot is the true pre-script state), then
    // "build" started while "run" was still active (its snapshot is "run"'s
    // materialized layout, since that's what was visible at the time).
    const originalSnapshot: RunScriptsSplitSnapshot = { root: null };
    const runLayout = pane("run-pane", "run-tab");
    const buildSnapshot: RunScriptsSplitSnapshot = { root: runLayout };

    const layoutStackRef: RefObject<Record<string, string[]>> = {
      current: { wt1: ["run", "build"] },
    };
    const dispatch = vi.fn<(action: WorkspaceAction) => void>();
    const setManagedScriptsState = vi.fn<(update: SetStateAction<ManagedScriptsState>) => void>();

    const stateBeforeStop: ManagedScriptsState = {
      wt1: {
        run: {
          worktreeId: "wt1",
          name: "run",
          tabIds: ["run-tab"],
          stopping: true,
          splitSnapshot: originalSnapshot,
        },
        build: {
          worktreeId: "wt1",
          name: "build",
          tabIds: ["build-tab"],
          stopping: false,
          splitSnapshot: buildSnapshot,
        },
      },
    };

    // Stopping "run" while "build" is still on top must not touch the
    // currently-visible split layout ("build"'s), only splice "run" out of
    // the chain so "build"'s eventual restore skips over it.
    popScriptLayout(
      dispatch,
      setManagedScriptsState,
      layoutStackRef,
      "wt1",
      "run",
      originalSnapshot,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(layoutStackRef.current.wt1).toEqual(["build"]);

    const stateAfterFirstStop = applyUpdate(setManagedScriptsState, stateBeforeStop);
    const updatedBuildSnapshot = entryFor(stateAfterFirstStop, "wt1", "build").splitSnapshot;
    expect(updatedBuildSnapshot).toEqual(originalSnapshot);

    // Now stop "build", the only script left on the stack: this should
    // restore the true original layout (via the spliced-in snapshot), not
    // "run"'s now-stale materialized layout.
    popScriptLayout(
      dispatch,
      setManagedScriptsState,
      layoutStackRef,
      "wt1",
      "build",
      updatedBuildSnapshot!,
    );

    expect(dispatch).toHaveBeenCalledWith({ type: "clear-split-root", worktreeId: "wt1" });
    expect(layoutStackRef.current.wt1).toBeUndefined();
  });

  it("restores directly when the stopped script is topmost", () => {
    const runLayout = pane("run-pane", "run-tab");
    const snapshot: RunScriptsSplitSnapshot = { root: runLayout };
    const layoutStackRef: RefObject<Record<string, string[]>> = { current: { wt1: ["run"] } };
    const dispatch = vi.fn<(action: WorkspaceAction) => void>();
    const setManagedScriptsState = vi.fn<(update: SetStateAction<ManagedScriptsState>) => void>();

    popScriptLayout(dispatch, setManagedScriptsState, layoutStackRef, "wt1", "run", snapshot);

    expect(dispatch).toHaveBeenCalledWith({
      type: "set-split-root",
      worktreeId: "wt1",
      root: runLayout,
    });
    expect(setManagedScriptsState).not.toHaveBeenCalled();
    expect(layoutStackRef.current.wt1).toBeUndefined();
  });

  it("chains a mid-stack removal past two newer scripts", () => {
    const originalSnapshot: RunScriptsSplitSnapshot = { root: null };
    const aLayout = pane("a-pane", "a-tab");
    const bSnapshot: RunScriptsSplitSnapshot = { root: aLayout };
    const bLayout = pane("b-pane", "b-tab");
    const cSnapshot: RunScriptsSplitSnapshot = { root: bLayout };

    const layoutStackRef: RefObject<Record<string, string[]>> = {
      current: { wt1: ["a", "b", "c"] },
    };
    const dispatch = vi.fn<(action: WorkspaceAction) => void>();
    const setManagedScriptsState = vi.fn<(update: SetStateAction<ManagedScriptsState>) => void>();

    let state: ManagedScriptsState = {
      wt1: {
        a: {
          worktreeId: "wt1",
          name: "a",
          tabIds: ["a-tab"],
          stopping: false,
          splitSnapshot: originalSnapshot,
        },
        b: {
          worktreeId: "wt1",
          name: "b",
          tabIds: ["b-tab"],
          stopping: false,
          splitSnapshot: bSnapshot,
        },
        c: {
          worktreeId: "wt1",
          name: "c",
          tabIds: ["c-tab"],
          stopping: false,
          splitSnapshot: cSnapshot,
        },
      },
    };

    // "a" (the bottom of the stack) stops first; its immediate successor is
    // "b", so "b"'s snapshot must be spliced past "a" to the true original.
    popScriptLayout(dispatch, setManagedScriptsState, layoutStackRef, "wt1", "a", originalSnapshot);
    expect(dispatch).not.toHaveBeenCalled();
    expect(layoutStackRef.current.wt1).toEqual(["b", "c"]);
    state = applyUpdate(setManagedScriptsState, state);
    const updatedBSnapshot = entryFor(state, "wt1", "b").splitSnapshot;
    expect(updatedBSnapshot).toEqual(originalSnapshot);

    // "b" stops next; "c" is above it, so its snapshot must be spliced
    // forward to "b"'s (already-corrected) restore point.
    popScriptLayout(
      dispatch,
      setManagedScriptsState,
      layoutStackRef,
      "wt1",
      "b",
      updatedBSnapshot!,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(layoutStackRef.current.wt1).toEqual(["c"]);
    state = applyUpdate(setManagedScriptsState, state);
    const updatedCSnapshot = entryFor(state, "wt1", "c").splitSnapshot;
    expect(updatedCSnapshot).toEqual(originalSnapshot);

    // "c" stops last: restores the true original, never "a" or "b"'s stale layouts.
    popScriptLayout(
      dispatch,
      setManagedScriptsState,
      layoutStackRef,
      "wt1",
      "c",
      updatedCSnapshot!,
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "clear-split-root", worktreeId: "wt1" });
    expect(layoutStackRef.current.wt1).toBeUndefined();
  });
});
