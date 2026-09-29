import { constants, type System1Settings } from "@pragma-sh/constants";

import { readConfig, writeConfig } from "@/lib/tauri";

/** Starter `automode.md` offered when the file does not exist yet. */
export const AUTO_MODE_TEMPLATE = `---
# Hard rules, enforced before the System 1 model is asked.
# Globs: * matches anything. Models are "model" or "agent/model".
agents:
  include: []
  exclude: []
models:
  include: []
  exclude: []
# What to favour when nothing else decides: accuracy, speed, efficiency, or balanced.
priority: balanced
---

Describe when to use each agent and model, in your own words. Auto mode
passes this text to the System 1 model as your priorities.

- Use Codex for quick, scripted fixes and CI failures.
- Use Claude Code with Opus for multi-file refactors.
`;

/**
 * The model route used when none is configured, for the given endpoint URL:
 * what that host expects (OpenRouter: `~typesafe/jev-latest`), else Jev's
 * default. Mirrors `resolve_model` in `system1.rs`; both read the same
 * `constants.system1.hostModels` table.
 */
export function defaultSystem1Model(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return constants.system1.defaultModel;
  }
  const match = constants.system1.hostModels.find(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
  );
  return match?.model ?? constants.system1.defaultModel;
}

/** Rejects a `system1` config block of the wrong shape. Absent fields mean "default". */
export function validateSystem1Settings(settings: System1Settings | undefined): void {
  if (settings === undefined) return;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("system1 must be an object");
  }
  for (const key of ["baseUrl", "model"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      throw new Error(`system1.${key} must be a string`);
    }
  }
}

/**
 * Applies a `system1` patch to a config object. A blank value removes the
 * field (so the shipped default applies) and an empty block is removed too.
 */
export function applySystem1Patch<C extends { system1?: System1Settings }>(
  config: C,
  patch: System1Settings,
): C {
  const next: System1Settings = { ...config.system1 };
  for (const [key, value] of Object.entries(patch) as [
    keyof System1Settings,
    string | undefined,
  ][]) {
    if (value?.trim()) next[key] = value.trim();
    else delete next[key];
  }
  const { system1: _previous, ...rest } = config;
  return (Object.keys(next).length > 0 ? { ...rest, system1: next } : rest) as C;
}

/**
 * Patches the global `config.json` directly. For surfaces outside Settings
 * (onboarding); Settings itself goes through its own queued `persist`.
 */
export async function saveGlobalSystem1Settings(patch: System1Settings): Promise<void> {
  const document = await readConfig("global");
  const parsed: unknown = document.exists ? JSON.parse(document.contents) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json root must be an object");
  }
  const next = applySystem1Patch(parsed as { system1?: System1Settings }, patch);
  await writeConfig("global", `${JSON.stringify(next, null, 2)}\n`);
  window.dispatchEvent(new Event("pragma:config-changed"));
}
