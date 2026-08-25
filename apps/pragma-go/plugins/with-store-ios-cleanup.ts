import { type ConfigPlugin, withInfoPlist } from "expo/config-plugins";

/** The Bonjour service `expo-dev-client` advertises to find a dev server. */
const DEV_LAUNCHER_BONJOUR = "_expo._tcp";

/** The URL scheme `expo-dev-client` registers so a dev build can be deep-linked. */
const DEV_LAUNCHER_SCHEME_PREFIX = "exp+";

/**
 * Strips the `expo-dev-client` traces from a store build's `Info.plist`.
 *
 * The dev launcher's pods are Debug-only, but its config plugin writes its
 * plist keys into *every* prebuild — so a release binary ships a Bonjour
 * service it never browses and an `exp+pragma-go` URL scheme nothing handles.
 * App Review reads those as undeclared capabilities, and the local-network
 * prompt the user sees is justified by a string about development servers.
 *
 * Pragma Go still needs local networking (a desktop reached at a LAN address),
 * so the usage description is rewritten rather than removed; only the
 * dev-server discovery machinery goes.
 *
 * Applied by `app.config.ts` when `PRAGMA_STORE_BUILD` is set, so a dev-client
 * prebuild keeps the discovery it depends on.
 */
export const withStoreIosCleanup: ConfigPlugin = (config) =>
  withInfoPlist(config, (plist) => {
    const bonjour = plist.modResults.NSBonjourServices as string[] | undefined;
    if (bonjour) {
      const kept = bonjour.filter((service) => service !== DEV_LAUNCHER_BONJOUR);
      if (kept.length > 0) plist.modResults.NSBonjourServices = kept;
      else delete plist.modResults.NSBonjourServices;
    }
    const urlTypes = plist.modResults.CFBundleURLTypes;
    if (urlTypes) {
      plist.modResults.CFBundleURLTypes = urlTypes
        .map((type) => ({
          ...type,
          CFBundleURLSchemes: (type.CFBundleURLSchemes ?? []).filter(
            (scheme) => !scheme.startsWith(DEV_LAUNCHER_SCHEME_PREFIX),
          ),
        }))
        .filter((type) => type.CFBundleURLSchemes.length > 0);
    }
    return plist;
  });

export default withStoreIosCleanup;
