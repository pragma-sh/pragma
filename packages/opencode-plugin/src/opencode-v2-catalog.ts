import type { AgentMode, AgentModelEntry } from "@pragma-sh/plugin/catalog";

import { responseData } from "./opencode-api";

/**
 * OpenCode v2's own model and agent lists, read from its server API
 * (`GET /api/model`, `/api/provider`, `/api/agent`; verified against 2.1.1).
 *
 * `opencode models` on v2 prints bare ids, and its model picker searches by
 * display name and provider title — never by id — so both the launcher's list
 * and the watcher that drives that picker need the names from here.
 */

/** One model as OpenCode v2 lists it. */
export interface OpenCodeV2Model {
  /** Model id within its provider (`gpt-5.6-sol`). */
  id: string;
  providerID: string;
  /** Display name the model picker shows and searches (`GPT-5.6 Sol`). */
  name: string;
  /** Reasoning variant ids, in OpenCode's order (lowest effort first). */
  variants: string[];
}

function records(response: unknown): Record<string, unknown>[] {
  const data = responseData(response);
  return Array.isArray(data)
    ? data.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function variantIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((variant) => {
    const id = text((variant as { id?: unknown } | null)?.id);
    return id ? [id] : [];
  });
}

/** Reads `GET /api/model`: every enabled model that has an id and a provider. */
export function readOpenCodeV2Models(response: unknown): OpenCodeV2Model[] {
  return records(response).flatMap((model) => {
    const id = text(model.id);
    const providerID = text(model.providerID);
    if (!id || !providerID || model.enabled === false) return [];
    return [{ id, providerID, name: text(model.name) || id, variants: variantIds(model.variants) }];
  });
}

/** Reads `GET /api/provider` into provider id → the title the model picker shows. */
export function readOpenCodeV2Providers(response: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  for (const provider of records(response)) {
    const id = text(provider.id);
    const name = text(provider.name);
    if (id && name) titles.set(id, name);
  }
  return titles;
}

/** The id Pragma selects a v2 model by: `provider/model`, as `opencode models` prints it. */
export function openCodeV2ModelId(model: Pick<OpenCodeV2Model, "id" | "providerID">): string {
  return `${model.providerID}/${model.id}`;
}

function titleCase(id: string): string {
  return id ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/** The launcher's model list for v2, with each model's reasoning variants. */
export function openCodeV2ModelEntries(models: OpenCodeV2Model[]): AgentModelEntry[] {
  return models.map((model) => ({
    id: openCodeV2ModelId(model),
    name: `${model.name} (${model.providerID})`,
    ...(model.variants.length > 0
      ? { reasoning: model.variants.map((id) => ({ id, name: titleCase(id) })) }
      : {}),
  }));
}

/** OpenCode's own primary agents, listed first. */
const BUILTIN_AGENT_ORDER = ["build", "plan"];

/**
 * Reads `GET /api/agent` into the agents OpenCode's "Switch agent" picker
 * offers: every agent that is not a subagent and not hidden, `build` and
 * `plan` first.
 */
export function readOpenCodeV2Agents(response: unknown): AgentMode[] {
  const rank = (id: string): number => {
    const index = BUILTIN_AGENT_ORDER.indexOf(id);
    return index === -1 ? BUILTIN_AGENT_ORDER.length : index;
  };
  return records(response)
    .filter((agent) => agent.mode !== "subagent" && agent.hidden !== true && text(agent.id))
    .map((agent) => {
      const id = text(agent.id);
      // A user-defined agent's name is its id; only capitalise that case.
      const name = text(agent.name);
      return { id, name: name && name !== id ? name : titleCase(id) };
    })
    .toSorted((a, b) => rank(a.id) - rank(b.id));
}
