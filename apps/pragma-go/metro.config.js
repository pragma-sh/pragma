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
// Hierarchical lookup stays ON. Bun's hoisted linker still nests a dependency
// whenever two packages need different majors — `semver@7.5.3` keeps its own
// `lru-cache@6` under `node_modules/semver/node_modules`. Disabling the walk
// makes semver resolve the hoisted `lru-cache@11`, whose CommonJS entry exports
// an object rather than the v6 class, so `new LRU()` in `semver/classes/range.js`
// throws "Object cannot be used as a constructor" while Reanimated validates the
// Worklets version — i.e. the app dies before the first screen renders.

module.exports = withNativeWind(config, { input: "./global.css" });
