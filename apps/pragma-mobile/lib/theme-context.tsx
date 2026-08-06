import type { HostTheme, PragmaClient } from "@pragma/sdk";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, useColorScheme, View } from "react-native";
import { vars } from "nativewind";

import { useConnection } from "./connection-context";
import { themeKey, themeVars, type ThemeOverrides } from "./theme-vars";
import { getViewedProjectRoot, subscribeViewedProject } from "./viewed-project";

/**
 * Mirrors the desktop's user theme onto this app.
 *
 * The host serves the merged `.pragma/theme.json` overrides over the gateway;
 * they are converted to NativeWind variables and applied to a root view, which
 * puts every `bg-background`-style class on the user's colors without touching
 * a single screen. A phone with no paired host — or a host with no theme file —
 * keeps the defaults in `global.css`, so this is purely additive.
 *
 * Only the scheme the device is currently in is applied: NativeWind variables
 * are values, not CSS rules, so there is no `.dark` selector to switch between.
 * Flipping the system appearance re-renders with that scheme's overrides.
 *
 * The theme is polled rather than pushed. Editing the desktop theme rewrites a
 * file the gateway only reads on request — there is no `themeChanged`
 * subscription to ride — so a one-shot fetch at pair time would leave the phone
 * on a stale palette until the app restarted.
 */
interface ThemeContextValue {
  /** Overrides for the device's current scheme, keyed by desktop token name. */
  overrides: ThemeOverrides;
}

/** How often a foregrounded app re-reads the host theme. */
const THEME_POLL_MS = 10_000;

const ThemeContext = createContext<ThemeContextValue>({ overrides: {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { client } = useConnection();
  const root = useSyncExternalStore(subscribeViewedProject, getViewedProjectRoot);
  const theme = useHostTheme(client, root);
  const scheme = useColorScheme() === "dark" ? "dark" : "light";

  const overrides = useMemo<ThemeOverrides>(() => theme?.colors?.[scheme] ?? {}, [theme, scheme]);
  const style = useMemo(() => vars(themeVars(overrides)), [overrides]);
  const value = useMemo<ThemeContextValue>(() => ({ overrides }), [overrides]);

  return (
    <ThemeContext.Provider value={value}>
      <View style={[{ flex: 1 }, style]}>{children}</View>
    </ThemeContext.Provider>
  );
}

/**
 * The paired host's theme for the viewed project's root (its `.pragma/theme.json`
 * layered over the global one), refreshed while the app is in front and again
 * the moment it returns from the background — so a theme edited on the desktop
 * with the phone asleep is applied on the next look at the screen, not minutes
 * later.
 */
function useHostTheme(client: PragmaClient | null, root: string | null): HostTheme | null {
  // The theme is stored with the client that served it, so unpairing (or
  // pairing a different host) drops it by comparison at render time rather than
  // by clearing state from an effect.
  const [fetched, setFetched] = useState<{ owner: PragmaClient; theme: HostTheme } | null>(null);
  // Identity of the applied theme. Re-setting an equal object would rebuild the
  // variable map and re-render every screen on each poll.
  const applied = useRef<string | null>(null);
  // Monotonic request id. Polls overlap (interval vs. foregrounding), and a
  // fetch that started before the theme changed must not apply over one that
  // read after: only the latest request may set state.
  const requestSeq = useRef(0);

  useEffect(() => {
    applied.current = null;
    if (!client) return undefined;
    let cancelled = false;
    const apply = (theme: HostTheme) => {
      const key = themeKey(theme);
      if (key === applied.current) return;
      applied.current = key;
      setFetched({ owner: client, theme });
    };
    const refresh = async () => {
      const seq = ++requestSeq.current;
      const next = await fetchTheme(client, root);
      if (cancelled || next === null || seq !== requestSeq.current) return;
      apply(next);
    };
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, THEME_POLL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [client, root]);

  return fetched && fetched.owner === client ? fetched.theme : null;
}

/**
 * One poll. A host that cannot serve a theme returns `null`, which keeps the
 * palette already in effect: a dropped tunnel is not a reason to flash back to
 * the shipped colors, and there is nothing here for the user to act on.
 */
async function fetchTheme(client: PragmaClient, root: string | null): Promise<HostTheme | null> {
  try {
    return await client.theme.get(root ? { root } : {});
  } catch {
    return null;
  }
}

/** The host theme overrides in effect for the device's current scheme. */
export function useHostThemeOverrides(): ThemeOverrides {
  return useContext(ThemeContext).overrides;
}
