import type { HostTheme, PragmaClient } from "@pragma/sdk";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, useColorScheme, View } from "react-native";
import { vars } from "nativewind";

import { useConnection } from "./connection-context";
import { themeKey, themeVars, type ThemeOverrides } from "./theme-vars";

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
  const theme = useHostTheme(client);
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
 * The paired host's theme, refreshed while the app is in front and again the
 * moment it returns from the background — so a theme edited on the desktop with
 * the phone asleep is applied on the next look at the screen, not minutes later.
 */
function useHostTheme(client: PragmaClient | null): HostTheme | null {
  // The theme is stored with the client that served it, so unpairing (or
  // pairing a different host) drops it by comparison at render time rather than
  // by clearing state from an effect.
  const [fetched, setFetched] = useState<{ owner: PragmaClient; theme: HostTheme } | null>(null);
  // Identity of the applied theme. Re-setting an equal object would rebuild the
  // variable map and re-render every screen on each poll.
  const applied = useRef<string | null>(null);

  useEffect(() => {
    applied.current = null;
    if (!client) return undefined;
    let cancelled = false;
    const refresh = async () => {
      const next = await fetchTheme(client);
      if (cancelled || next === null) return;
      const key = themeKey(next);
      if (key === applied.current) return;
      applied.current = key;
      setFetched({ owner: client, theme: next });
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
  }, [client]);

  return fetched && fetched.owner === client ? fetched.theme : null;
}

/**
 * One poll. A host that cannot serve a theme returns `null`, which keeps the
 * palette already in effect: a dropped tunnel is not a reason to flash back to
 * the shipped colors, and there is nothing here for the user to act on.
 */
async function fetchTheme(client: PragmaClient): Promise<HostTheme | null> {
  try {
    return await client.theme.get();
  } catch {
    return null;
  }
}

/** The host theme overrides in effect for the device's current scheme. */
export function useHostThemeOverrides(): ThemeOverrides {
  return useContext(ThemeContext).overrides;
}
