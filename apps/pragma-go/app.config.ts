import type { ExpoConfig } from "expo/config";

import base from "./app.json";

/**
 * Expo config for Pragma Go.
 *
 * Everything static lives in `app.json`; this wrapper exists only to inject the
 * web deployment sub-path. The gateway serves the exported bundle under `/web`,
 * so every asset URL has to be prefixed — but `baseUrl` must never reach a
 * native build, where it would break asset resolution. Keeping it env-gated
 * means `expo run:ios` and `expo export --platform web` share one config.
 */
export default (): ExpoConfig => {
  const config = base.expo as unknown as ExpoConfig;
  const baseUrl = process.env.EXPO_BASE_URL;
  if (!baseUrl) {
    return config;
  }
  return {
    ...config,
    experiments: { ...config.experiments, baseUrl },
  };
};
