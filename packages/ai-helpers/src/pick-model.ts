import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { type ModelKind, PICK_MODEL } from "./constants.ts";
import { isModelRecent, parseModelReleaseDate } from "./model-date.ts";

/** A blended price used to rank candidates; lower is cheaper. */
function costScore(model: Model<Api>): number {
  return model.cost.input + model.cost.output;
}

/** Whether a model satisfies the non-reasoning preference for quick helpers. */
function matchesQuickPreference(model: Model<Api>): boolean {
  return model.reasoning === PICK_MODEL.quick.reasoning;
}

/** Whether a model satisfies the non-negotiable requirements for the requested tier. */
function matchesKindBase(model: Model<Api>, kind: ModelKind): boolean {
  if (kind === "quick") {
    return model.contextWindow <= PICK_MODEL.quick.maxContextWindow;
  }
  return (
    model.reasoning === PICK_MODEL.standard.reasoning &&
    model.contextWindow > PICK_MODEL.standard.minContextWindow
  );
}

function compareModels(a: Model<Api>, b: Model<Api>): number {
  const scoreDiff = costScore(a) - costScore(b);
  if (scoreDiff !== 0) return scoreDiff;

  const dateDiff =
    (parseModelReleaseDate(b)?.getTime() ?? 0) - (parseModelReleaseDate(a)?.getTime() ?? 0);
  if (dateDiff !== 0) return dateDiff;

  const contextDiff = b.contextWindow - a.contextWindow;
  if (contextDiff !== 0) return contextDiff;

  return a.id.localeCompare(b.id);
}

/**
 * Pure selection: from `models`, keep only recent ones that satisfy the
 * requested tier, then return every candidate in selection order. Quick models
 * prefer non-reasoning when any non-reasoning model satisfies the other
 * constraints, otherwise they fall back to reasoning models.
 */
export function selectModelCandidates(
  kind: ModelKind,
  models: readonly Model<Api>[],
  now?: Date,
): Model<Api>[] {
  const baseCandidates = models.filter(
    (model) => matchesKindBase(model, kind) && isModelRecent(model, PICK_MODEL.maxAgeMonths, now),
  );
  const preferredQuickCandidates =
    kind === "quick" ? baseCandidates.filter(matchesQuickPreference) : [];
  const candidates =
    kind === "quick" && preferredQuickCandidates.length > 0
      ? preferredQuickCandidates
      : baseCandidates;

  return candidates.toSorted(compareModels);
}

/**
 * Pure selection: from `models`, keep only recent ones that satisfy the
 * requested tier, then return the cheapest. Ties break toward the newer model,
 * then the larger context window, then a stable id order. Returns `undefined`
 * when nothing qualifies.
 */
export function selectModel(
  kind: ModelKind,
  models: readonly Model<Api>[],
  now?: Date,
): Model<Api> | undefined {
  return selectModelCandidates(kind, models, now)[0];
}

/**
 * Pick the cheapest recent model of the requested tier from the registry's
 * available (authenticated) models. Returns `undefined` when no model qualifies
 * — e.g. the user has not authenticated any provider that offers one.
 */
export function pickModel(
  kind: ModelKind,
  options: { authStorage: AuthStorage; registry: ModelRegistry; now?: Date },
): Model<Api> | undefined {
  return selectModel(kind, options.registry.getAvailable(), options.now);
}
