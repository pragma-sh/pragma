/**
 * Side-effect-free version entry point. The Pragma host imports this subpath
 * (`@pragma/plugin/version`) to learn which plugin API version it supports —
 * unlike the main barrel, importing this never touches the runtime bridge, so
 * it is safe before `globalThis.__PRAGMA__` is installed.
 */
export { PLUGIN_API_VERSION } from "./generated/version";
