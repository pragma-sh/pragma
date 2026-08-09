import { useCallback, useEffect, useState } from "react";

import type { ShellProfile, TerminalSettings } from "@pragma/constants";

import { resolveDefaultProfile, resolveHiddenDistros } from "@/lib/shell-profile";
import { readConfig } from "@/lib/tauri";

/**
 * Window event fired after Settings writes the `terminal` block, so an open
 * new-tab menu reflects the new default without reopening the workspace.
 * Mirrors `KEYBINDINGS_CHANGED_EVENT`.
 */
export const TERMINAL_SETTINGS_CHANGED_EVENT = "pragma:terminal-settings-changed";

/** The effective terminal settings, resolved across both Settings scopes. */
export interface ResolvedTerminalSettings {
  /** The configured default shell, or `null` when no scope names one. */
  defaultProfile: ShellProfile | null;
  /** Distribution names to omit from pickers; `undefined` uses the shipped list. */
  hiddenDistros: string[] | undefined;
}

const NOTHING_CONFIGURED: ResolvedTerminalSettings = {
  defaultProfile: null,
  hiddenDistros: undefined,
};

/**
 * Reads the `terminal` block of one config scope.
 *
 * A missing, unreadable, or malformed file yields `undefined` rather than
 * throwing: a broken config must not stop the new-tab menu from rendering, the
 * same tolerance the server applies when it resolves the shell.
 */
async function readTerminalScope(
  scope: "global" | "project",
  projectId?: string | null,
): Promise<TerminalSettings | undefined> {
  try {
    const document = await readConfig(scope, projectId);
    if (!document?.exists) return undefined;
    const parsed: unknown = JSON.parse(document.contents);
    if (!parsed || typeof parsed !== "object") return undefined;
    const terminal = (parsed as { terminal?: unknown }).terminal;
    return terminal && typeof terminal === "object" ? (terminal as TerminalSettings) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The default shell the session layer will launch for `projectId`, resolved
 * project-scope-first exactly as the server resolves it.
 *
 * This is what the new-tab menu marks as "Default" — WSL's own default
 * distribution is a different thing entirely and must not be confused for it.
 */
export function useTerminalSettings(projectId: string | null): ResolvedTerminalSettings {
  const [settings, setSettings] = useState<ResolvedTerminalSettings>(NOTHING_CONFIGURED);

  const load = useCallback(async (): Promise<ResolvedTerminalSettings> => {
    const [project, global] = await Promise.all([
      projectId ? readTerminalScope("project", projectId) : Promise.resolve(undefined),
      readTerminalScope("global"),
    ]);
    const scopes = [project, global];
    return {
      defaultProfile: resolveDefaultProfile(scopes),
      hiddenDistros: resolveHiddenDistros(scopes),
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void load().then((resolved) => {
        if (!cancelled) setSettings(resolved);
        return resolved;
      });
    };
    refresh();
    window.addEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, refresh);
    };
  }, [load]);

  return settings;
}
