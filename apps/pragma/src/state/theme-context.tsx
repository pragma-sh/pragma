import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { readTheme, type ConfigScope } from "@/lib/tauri";
import {
  applyThemeOverrides,
  mergeThemeOverrides,
  parseThemeFile,
  THEME_CHANGED_EVENT,
  THEME_MODES,
  type ThemeFile,
  type ThemeOverrides,
} from "@/lib/theme";
import { type ThemeMode } from "@/lib/theme-tokens";
import { useWorkspace } from "@/state/workspace-context";

/** Loaded theme layers plus a manual reload for the Settings editor. */
export interface ThemeState {
  /** `~/.pragma/theme.json`, or `null` when absent or unreadable. */
  global: ThemeFile | null;
  /** The selected project's `.pragma/theme.json`, or `null`. */
  project: ThemeFile | null;
  /** Parse/IO failure per scope, surfaced by Settings. */
  errors: Partial<Record<ConfigScope, string>>;
  /** Schedules a re-read of both scopes and re-applies the merged result. */
  reload: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

async function loadScope(
  scope: ConfigScope,
  projectId: string | null,
): Promise<{ file: ThemeFile | null; error?: string }> {
  if (scope === "project" && !projectId) return { file: null };
  try {
    const document = await readTheme(scope, projectId);
    if (!document.exists) return { file: null };
    return { file: parseThemeFile(document.contents) };
  } catch (cause) {
    return { file: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function mergedOverrides(
  global: ThemeFile | null,
  project: ThemeFile | null,
): Partial<Record<ThemeMode, ThemeOverrides>> {
  const overrides: Partial<Record<ThemeMode, ThemeOverrides>> = {};
  for (const mode of THEME_MODES) overrides[mode] = mergeThemeOverrides(mode, global, project);
  return overrides;
}

/**
 * Loads and applies `.pragma/theme.json` color overrides. The project layer is
 * keyed on the selected project, so switching projects re-applies its theme
 * immediately; a project without a theme file falls back to the global one.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { selectedProjectId } = useWorkspace();
  const [global, setGlobal] = useState<ThemeFile | null>(null);
  const [project, setProject] = useState<ThemeFile | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ConfigScope, string>>>({});
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [globalResult, projectResult] = await Promise.all([
        loadScope("global", null),
        loadScope("project", selectedProjectId),
      ]);
      if (cancelled) return;
      setGlobal(globalResult.file);
      setProject(projectResult.file);
      setErrors({ global: globalResult.error, project: projectResult.error });
      applyThemeOverrides(mergedOverrides(globalResult.file, projectResult.file));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, generation]);

  useEffect(() => {
    const onChanged = () => setGeneration((value) => value + 1);
    window.addEventListener(THEME_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChanged);
  }, []);

  const state = useMemo<ThemeState>(
    () => ({ global, project, errors, reload }),
    [global, project, errors, reload],
  );

  return <ThemeContext value={state}>{children}</ThemeContext>;
}

/** Returns the loaded theme layers. Must be used inside {@link ThemeProvider}. */
export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error("useTheme must be used within ThemeProvider");
  return state;
}
