import type { AgentSessionLaunchPayload } from "@pragma/sdk";

import type { AgentModelSelection } from "./data/agents";

// Pure, RN-free launch-form model. The launch sheet holds this state and turns
// it into an AgentSessionLaunchPayload; validation + payload shaping are unit
// tested here so the sheet component stays a thin view.

/** Where a launched session runs: the current worktree, or a fresh one. */
export type LaunchTarget = { kind: "existing" } | { kind: "new"; branch: string; title: string };

/** The launch sheet's editable state. */
export interface LaunchFormState {
  selection: AgentModelSelection | null;
  prompt: string;
  target: LaunchTarget;
}

/** Context supplied by the worktree the sheet was opened from. */
export interface LaunchContext {
  projectId: string;
  worktreeId: string;
}

/** A fresh launch form defaulting to the current worktree. */
export function initialLaunchForm(selection: AgentModelSelection | null): LaunchFormState {
  return { selection, prompt: "", target: { kind: "existing" } };
}

export type BuildResult =
  | { ok: true; payload: AgentSessionLaunchPayload }
  | { ok: false; reason: string };

/** Validates the form and shapes the brokered launch payload. */
export function buildLaunchPayload(state: LaunchFormState, context: LaunchContext): BuildResult {
  if (!state.selection) {
    return { ok: false, reason: "Choose an agent to launch." };
  }
  const prompt = state.prompt.trim();
  const base = {
    projectId: context.projectId,
    agentId: state.selection.agentId,
    modelId: state.selection.modelId || null,
    reasoningId: state.selection.reasoningId,
    prompt: prompt || null,
  };

  if (state.target.kind === "new") {
    const branch = state.target.branch.trim();
    if (!branch) {
      return { ok: false, reason: "Enter a branch name for the new worktree." };
    }
    return {
      ok: true,
      payload: {
        ...base,
        worktreeId: null,
        newWorktree: {
          parentWorktreeId: context.worktreeId,
          branch,
          title: state.target.title.trim() || null,
        },
      },
    };
  }

  return {
    ok: true,
    payload: { ...base, worktreeId: context.worktreeId, newWorktree: null },
  };
}
