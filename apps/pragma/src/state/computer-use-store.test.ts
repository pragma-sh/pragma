import { describe, expect, it } from "vitest";

import type {
  ComputerActivityEvent,
  ComputerActivitySnapshot,
  ComputerSession,
} from "@pragma-sh/constants";

import {
  applyComputerMessage,
  controlledApps,
  INITIAL_COMPUTER_USE,
  sessionsForWorktree,
  type ComputerUseState,
} from "@/state/computer-use-store";

const session: ComputerSession = {
  id: "cs_1",
  owner: { kind: "agentTab", tabId: "t1", agentId: "claude-code", label: "Claude Code" },
  worktreeId: "wt-1",
  leases: [{ appKey: "com.apple.safari", appName: "Safari", acquiredAt: 1 }],
  startedAt: 1,
  lastActionAt: 1,
  actionCount: 0,
  paused: false,
};

const snapshot: ComputerActivitySnapshot = {
  enabled: true,
  desktopConnected: true,
  sessions: [],
  approvals: [],
  helper: { state: "ready" },
  stopped: false,
  lastSeq: 0,
};

function delta(event: Partial<ComputerActivityEvent> & Pick<ComputerActivityEvent, "type">) {
  return { kind: "delta" as const, payload: { seq: 1, at: 100, ...event } };
}

function started(): ComputerUseState {
  return applyComputerMessage(INITIAL_COMPUTER_USE, { kind: "snapshot", payload: snapshot });
}

describe("applyComputerMessage", () => {
  it("ignores deltas until the first snapshot", () => {
    const next = applyComputerMessage(
      INITIAL_COMPUTER_USE,
      delta({ type: "sessionStarted", session }),
    );
    expect(next).toBe(INITIAL_COMPUTER_USE);
  });

  it("tracks sessions and their cursors through an action", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    expect(state.snapshot?.sessions).toHaveLength(1);
    state = applyComputerMessage(
      state,
      delta({
        type: "actionStarted",
        sessionId: "cs_1",
        description: "Click “Sign in”",
        pointer: { to: { x: 10, y: 20 }, leadMs: 150 },
      }),
    );
    expect(state.cursors.cs_1?.point).toEqual({ x: 10, y: 20 });
    expect(state.cursors.cs_1?.description).toBe("Click “Sign in”");
    state = applyComputerMessage(
      state,
      delta({
        type: "actionCompleted",
        sessionId: "cs_1",
        session: { ...session, actionCount: 1 },
        physicalCursor: false,
      }),
    );
    expect(state.cursors.cs_1?.pulses).toBe(1);
    expect(state.snapshot?.sessions[0]?.actionCount).toBe(1);
    state = applyComputerMessage(state, delta({ type: "sessionEnded", sessionId: "cs_1" }));
    expect(state.snapshot?.sessions).toEqual([]);
    expect(state.cursors).toEqual({});
  });

  it("freezes a paused cursor despite late action and tracking events", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    state = applyComputerMessage(
      state,
      delta({
        type: "actionStarted",
        sessionId: session.id,
        pointer: { to: { x: 10, y: 20 }, leadMs: 150 },
      }),
    );
    state = applyComputerMessage(
      state,
      delta({
        type: "sessionPaused",
        sessionId: session.id,
        session: { ...session, paused: true, pauseReason: "takeover" },
      }),
    );
    for (const type of ["actionStarted", "cursorMoved"] as const) {
      state = applyComputerMessage(
        state,
        delta({ type, sessionId: session.id, pointer: { to: { x: 999, y: 999 }, leadMs: 150 } }),
      );
    }
    expect(state.cursors[session.id]?.point).toEqual({ x: 10, y: 20 });
    expect(state.snapshot?.sessions[0]?.paused).toBe(true);
  });

  it("keeps the target window and whether it is covered with the cursor", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    const window = { x: 100, y: 50, w: 400, h: 300 };
    state = applyComputerMessage(
      state,
      delta({
        type: "actionStarted",
        sessionId: "cs_1",
        pointer: { to: { x: 120, y: 60 }, window, covered: true, leadMs: 0 },
      }),
    );
    expect(state.cursors.cs_1?.window).toEqual(window);
    expect(state.cursors.cs_1?.covered).toBe(true);
  });

  it("moves the cursor with its window between actions", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    state = applyComputerMessage(
      state,
      delta({
        type: "actionStarted",
        sessionId: "cs_1",
        description: "Click “Sign in”",
        pointer: { to: { x: 120, y: 60 }, window: { x: 100, y: 50, w: 400, h: 300 }, leadMs: 150 },
      }),
    );
    const window = { x: 300, y: 50, w: 400, h: 300 };
    state = applyComputerMessage(
      state,
      delta({
        type: "cursorMoved",
        sessionId: "cs_1",
        pointer: { to: { x: 320, y: 60 }, window, covered: true, leadMs: 0 },
      }),
    );
    expect(state.cursors.cs_1).toMatchObject({
      point: { x: 320, y: 60 },
      window,
      covered: true,
      tracking: true,
      description: "Click “Sign in”",
    });
  });

  it("ignores cursor tracking for a session with no cursor", () => {
    const state = applyComputerMessage(
      started(),
      delta({ type: "cursorMoved", sessionId: "cs_9", pointer: { to: { x: 1, y: 1 }, leadMs: 0 } }),
    );
    expect(state.cursors).toEqual({});
  });

  it("adds and resolves approvals once each", () => {
    const approval = {
      id: "ap_1",
      caller: session.owner,
      op: "click" as const,
      reason: "Claude Code wants to use your computer",
      sensitive: false,
      requestedAt: 1,
      expiresAt: 2,
    };
    let state = applyComputerMessage(started(), delta({ type: "approvalRequested", approval }));
    state = applyComputerMessage(state, delta({ type: "approvalRequested", approval }));
    expect(state.snapshot?.approvals).toHaveLength(1);
    state = applyComputerMessage(state, delta({ type: "approvalResolved", approval }));
    expect(state.snapshot?.approvals).toEqual([]);
  });

  it("clears everything on the stop", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    state = applyComputerMessage(state, delta({ type: "stopped" }));
    expect(state.snapshot?.stopped).toBe(true);
    expect(state.snapshot?.sessions).toEqual([]);
  });

  it("drops cursors of sessions a new snapshot no longer has", () => {
    let state = applyComputerMessage(started(), delta({ type: "sessionStarted", session }));
    state = applyComputerMessage(
      state,
      delta({
        type: "actionStarted",
        sessionId: "cs_1",
        pointer: { to: { x: 1, y: 1 }, leadMs: 0 },
      }),
    );
    state = applyComputerMessage(state, { kind: "snapshot", payload: snapshot });
    expect(state.cursors).toEqual({});
  });
});

describe("helpers", () => {
  it("filters sessions by worktree", () => {
    const withSession = { ...snapshot, sessions: [session] };
    expect(sessionsForWorktree(withSession, "wt-1")).toHaveLength(1);
    expect(sessionsForWorktree(withSession, "wt-2")).toEqual([]);
    expect(sessionsForWorktree(null, "wt-1")).toEqual([]);
  });

  it("names controlled apps", () => {
    expect(controlledApps(session)).toBe("Safari");
    expect(controlledApps({ ...session, leases: [] })).toBe("your computer");
    expect(
      controlledApps({
        ...session,
        leases: [
          ...session.leases,
          { appKey: "com.apple.notes", appName: "Notes", acquiredAt: 2 },
          { appKey: "com.apple.mail", appName: "Mail", acquiredAt: 3 },
        ],
      }),
    ).toBe("Safari, Notes and Mail");
  });
});
