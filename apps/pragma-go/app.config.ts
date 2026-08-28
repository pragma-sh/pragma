import type { ExpoConfig } from "expo/config";

import base from "./app.json";

/**
 * Expo config for Pragma Go.
 *
 * Everything static lives in `app.json`; this wrapper exists only for the two
 * things that must not be baked into every build:
 *
 * - `EXPO_BASE_URL` injects the web deployment sub-path. The gateway serves the
 *   exported bundle under `/web`, so every asset URL has to be prefixed — but
 *   `baseUrl` must never reach a native build, where it would break asset
 *   resolution.
 * - `PRAGMA_STORE_BUILD` adds `with-store-ios-cleanup`, which strips the
 *   `expo-dev-client` traces from the iOS `Info.plist`. A dev-client prebuild
 *   needs the Bonjour service and the `exp+` scheme to find a dev server; a
 *   store binary must not ship them.
 *
 * Keeping both env-gated means `expo run:ios` and
 * `expo export --platform web` share one config.
 *
 * The cleanup plugin is registered **by path**, never imported: Expo transpiles
 * this file on its own, so a relative TypeScript import is unresolvable at
 * runtime (`Cannot find module './plugins/with-store-ios-cleanup'`). A path
 * string goes through Expo's own TS-aware plugin resolver. It is unshifted to
 * the **front** of the array because mods run last-registered-first, so the
 * first entry has the final say over the plist.
 */
export default (): ExpoConfig => {
  const config = base.expo as unknown as ExpoConfig;
  const baseUrl = process.env.EXPO_BASE_URL;
  const withBaseUrl = baseUrl
    ? { ...config, experiments: { ...config.experiments, baseUrl } }
    : config;
  if (!process.env.PRAGMA_STORE_BUILD) return withBaseUrl;
  return {
    ...withBaseUrl,
    plugins: ["./plugins/with-store-ios-cleanup", ...(withBaseUrl.plugins ?? [])],
  };
};
