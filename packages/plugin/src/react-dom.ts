import { getBridge } from "./bridge";

// Re-export every `react-dom` type for full IntelliSense; erased at compile
// time, never bundled (verbatimModuleSyntax).
export type * from "react-dom";

// See `react.ts` for why runtime values are sourced from the bridge instead
// of a real `react-dom` import — the same alias-loop hazard applies here.
const reactDom: typeof import("react-dom") = getBridge().reactDom;

// `--isolatedDeclarations` forbids destructured exports, so every export
// below is spelled out individually with its type explicitly annotated.
export default reactDom;
export const createPortal: typeof reactDom.createPortal = reactDom.createPortal;
export const flushSync: typeof reactDom.flushSync = reactDom.flushSync;
export const preconnect: typeof reactDom.preconnect = reactDom.preconnect;
export const prefetchDNS: typeof reactDom.prefetchDNS = reactDom.prefetchDNS;
export const preinit: typeof reactDom.preinit = reactDom.preinit;
export const preinitModule: typeof reactDom.preinitModule = reactDom.preinitModule;
export const preload: typeof reactDom.preload = reactDom.preload;
export const version: typeof reactDom.version = reactDom.version;
