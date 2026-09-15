// Metro config for the Pragma Mobile Expo app inside the Bun monorepo.
// Watches the repo root so workspace packages (e.g. @pragma/constants) resolve,
// and wires NativeWind's Tailwind pipeline for `global.css`.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so shared packages are picked up on change.
config.watchFolders = [workspaceRoot];

// Resolve modules from both the app and the hoisted workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Hierarchical lookup must stay ON. Bun's hoisted linker still nests a package
// when dependents need different majors (`semver@7.5.3` keeps `lru-cache@6`
// under `node_modules/semver/node_modules`). With the walk disabled, semver
// resolves the hoisted `lru-cache@11`, whose CJS entry exports `{ LRUCache }`,
// so `new LRU()` throws "Object cannot be used as a constructor" at startup
// and expo-updates' ErrorRecovery turns it into a launch crash (App Review).

module.exports = withNativeWind(config, { input: "./global.css" });
