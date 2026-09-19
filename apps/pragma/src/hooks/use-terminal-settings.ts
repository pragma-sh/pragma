import { useCallback, useEffect, useState } from "react";

import type { ShellProfile } from "@pragma-sh/constants";

import {
  loadTerminalScopes,
  resolveDefaultProfile,
  resolveHiddenDistros,
} from "@/lib/shell-profile";

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
 * The default shell the session layer will launch for `projectId`, resolved
 * project-scope-first exactly as the server resolves it.
 *
 * This is what the new-tab menu marks as "Default" — WSL's own default
 * distribution is a different thing entirely and must not be confused for it.
 */
export function useTerminalSettings(projectId: string | null): ResolvedTerminalSettings {
  const [settings, setSettings] = useState<ResolvedTerminalSettings>(NOTHING_CONFIGURED);

  const load = useCallback(async (): Promise<ResolvedTerminalSettings> => {
    const scopes = await loadTerminalScopes(projectId);
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
