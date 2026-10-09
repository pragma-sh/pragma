import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "sonner";

import { autoSelectUsage, type AccountsSnapshot } from "@pragma-sh/accounts-view";

import { validateModelSelection } from "@/lib/agent-model-selection";
import { errorMessage } from "@/lib/errors";
import {
  system1AutoSelect,
  type AgentConfig,
  type AgentModel,
  type AgentModelSelection,
  type AutoSelectInput,
  type AutoSelection,
} from "@/lib/tauri";
import { projectAccountsSnapshot } from "@/state/accounts-store";

/**
 * How long to wait for every agent's model list before asking anyway. A model
 * provider can hang (a CLI that never answers); auto mode then decides with
 * the lists it has rather than never deciding.
 */
const AUTO_SELECT_MODEL_WAIT_MS = 2_500;
/** How often a submit re-checks whether the model lists have arrived. */
const MODEL_POLL_MS = 50;
/**
 * How long a submit waits for the project's account list when nothing has
 * loaded it yet. Usage limits are evidence, not a gate: past this, Auto
 * decides without them.
 */
const ACCOUNTS_WAIT_MS = 1_500;

/** What auto mode is deciding for: the prompt plus where the launch will run. */
export interface AutoSelectTarget {
  prompt: string;
  /** Project whose `.pragma/automode.md` applies. */
  projectId?: string | null;
  project?: string | null;
  worktree?: string | null;
  branch?: string | null;
}

/** Decides one picker's Auto pick and applies it through the picker's `onChange`. */
type AutoResolver = () => Promise<void>;

/** Where every picker set to Auto in one dialog registers itself. */
export interface AutoRegistry {
  /** Adds a resolver; the returned function removes it again. */
  register: (resolver: AutoResolver) => () => void;
}

/** A launching dialog's submit, routed through the pickers set to Auto. */
export interface AutoSubmit {
  /** Hand to each picker as `autoRegistry`. */
  registry: AutoRegistry;
  /** True while System 1 is choosing for a submit; hold the submit button. */
  resolving: boolean;
  /**
   * True while any picker is set to Auto. The agent is unknown until submit, so
   * per-agent launch options (mode, permission mode) have nothing to apply to.
   */
  active: boolean;
  /**
   * Submits the dialog. Pickers on Auto are decided first — only now, never
   * while the user types — and `submit` then runs against the applied picks.
   */
  submit: () => Promise<void>;
}

/**
 * Wraps a dialog's `submit` so any picker on Auto asks System 1 at submit time.
 * The picks land through each picker's `onChange` (a state update), so the real
 * submit runs from an effect after that render commits, reading fresh state.
 * If System 1 fails the launch is abandoned with a toast, never sent with a
 * pick the user did not make.
 */
export function useAutoSubmit(submit: () => unknown): AutoSubmit {
  const resolvers = useRef(new Set<AutoResolver>());
  const latestSubmit = useRef(submit);
  latestSubmit.current = submit;
  const inFlight = useRef(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [registered, setRegistered] = useState(0);

  useEffect(() => {
    if (resolvedCount > 0) void latestSubmit.current();
  }, [resolvedCount]);

  const registry = useMemo<AutoRegistry>(
    () => ({
      register(resolver) {
        resolvers.current.add(resolver);
        setRegistered(resolvers.current.size);
        return () => {
          resolvers.current.delete(resolver);
          setRegistered(resolvers.current.size);
        };
      },
    }),
    [],
  );

  const run = useCallback(async () => {
    if (inFlight.current) return;
    if (resolvers.current.size === 0) {
      await latestSubmit.current();
      return;
    }
    inFlight.current = true;
    setResolving(true);
    try {
      await Promise.all([...resolvers.current].map((resolve) => resolve()));
      setResolvedCount((count) => count + 1);
    } catch (cause) {
      toast.error(`Auto could not pick an agent: ${errorMessage(cause)}`);
    } finally {
      inFlight.current = false;
      setResolving(false);
    }
  }, []);

  return { registry, resolving, active: registered > 0, submit: run };
}

/**
 * Builds the IPC request from the loaded agents, their model lists, and — when
 * the project's accounts are known — the usage limits each agent launches with.
 */
export function buildAutoSelectInput(
  target: AutoSelectTarget,
  agents: readonly AgentConfig[],
  modelsByAgent: Record<string, AgentModel[] | undefined>,
  accounts: AccountsSnapshot | null = null,
): AutoSelectInput {
  return {
    projectId: target.projectId ?? null,
    prompt: target.prompt,
    context: {
      project: target.project ?? null,
      worktree: target.worktree ?? null,
      branch: target.branch ?? null,
    },
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      models: modelsByAgent[agent.id] ?? [],
      ...(accounts ? { usage: autoSelectUsage(accounts, agent.id) } : {}),
    })),
  };
}

/**
 * Maps a pick onto a launchable selection, re-validated against the model list
 * the picker actually holds — a stale or unknown model id falls back to "no
 * model", never to a launch argument the agent would reject.
 */
export function autoSelectionToLaunch(
  result: AutoSelection,
  modelsByAgent: Record<string, AgentModel[] | undefined>,
): { agentId: string; selection: AgentModelSelection } {
  return {
    agentId: result.agentId,
    selection: validateModelSelection(modelsByAgent[result.agentId] ?? [], {
      modelId: result.modelId,
      reasoningId: result.reasoningId,
    }),
  };
}

/** True once every agent's model list has resolved (loaded or failed). */
function allModelsLoaded(
  agents: readonly AgentConfig[],
  modelsByAgent: Record<string, AgentModel[] | undefined>,
): boolean {
  return agents.every((agent) => modelsByAgent[agent.id] !== undefined);
}

/** Loads every agent's models when enabled, and reports when waiting is over. */
function useModelsSettled(
  enabled: boolean,
  agents: readonly AgentConfig[],
  modelsByAgent: Record<string, AgentModel[] | undefined>,
  onLoadModels: (agentId: string) => void,
): boolean {
  const [timedOut, setTimedOut] = useState(false);
  const load = useRef(onLoadModels);
  load.current = onLoadModels;
  // Keyed on the ids, not the array: callers often rebuild `agents` per render,
  // and restarting the wait on every render would mean it never times out.
  const agentIds = agents.map((agent) => agent.id).join("\u0000");
  useEffect(() => {
    if (!enabled) return;
    for (const id of agentIds.split("\u0000").filter(Boolean)) load.current(id);
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), AUTO_SELECT_MODEL_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, agentIds]);
  return timedOut || allModelsLoaded(agents, modelsByAgent);
}

/** The project's accounts for a pick; an unreachable host means "no usage data", never a failed pick. */
async function accountsForAutoSelect(projectId: string | null): Promise<AccountsSnapshot | null> {
  try {
    return await projectAccountsSnapshot(projectId, ACCOUNTS_WAIT_MS);
  } catch (cause) {
    console.warn("auto mode: account usage unavailable", cause);
    return null;
  }
}

/** Resolves once `check` holds, or once `deadline` (epoch ms) passes regardless. */
async function waitUntil(check: () => boolean, deadline: number): Promise<void> {
  if (check() || Date.now() >= deadline) return;
  await new Promise((resolve) => window.setTimeout(resolve, MODEL_POLL_MS));
  return waitUntil(check, deadline);
}

/**
 * Registers one picker on Auto with its dialog's {@link AutoRegistry}. While
 * `enabled` it preloads every agent's models so a submit need not wait; on
 * submit it asks the System 1 model and hands the launchable pick to
 * `onResolved`. Nothing is requested before the user submits.
 */
export function useAutoAgentSelection({
  enabled,
  registry,
  target,
  agents,
  modelsByAgent,
  onLoadModels,
  onResolved,
}: {
  enabled: boolean;
  registry: AutoRegistry | undefined;
  target: AutoSelectTarget;
  agents: readonly AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  onLoadModels: (agentId: string) => void;
  onResolved: (agentId: string, selection: AgentModelSelection) => void;
}): void {
  const settled = useModelsSettled(enabled, agents, modelsByAgent, onLoadModels);
  const latest = useRef({ settled, target, agents, modelsByAgent, onResolved });
  latest.current = { settled, target, agents, modelsByAgent, onResolved };

  const resolve = useCallback(async () => {
    const [accounts] = await Promise.all([
      accountsForAutoSelect(latest.current.target.projectId ?? null),
      waitUntil(() => latest.current.settled, Date.now() + AUTO_SELECT_MODEL_WAIT_MS),
    ]);
    const { target: current, agents: list, modelsByAgent: models } = latest.current;
    const result = await system1AutoSelect(buildAutoSelectInput(current, list, models, accounts));
    const launch = autoSelectionToLaunch(result, latest.current.modelsByAgent);
    latest.current.onResolved(launch.agentId, launch.selection);
  }, []);

  useEffect(() => {
    if (!enabled || !registry) return;
    return registry.register(resolve);
  }, [enabled, registry, resolve]);
}
