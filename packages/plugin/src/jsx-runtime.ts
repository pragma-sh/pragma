import { getBridge } from "./bridge";
import type {
  Fragment as ReactFragment,
  jsx as reactJsx,
  jsxs as reactJsxs,
} from "react/jsx-runtime";

// See `react.ts` for why runtime values are sourced from the bridge instead of
// a real `react/jsx-runtime` import.
const jsxRuntime = getBridge().jsxRuntime;

export const jsx: typeof reactJsx = jsxRuntime.jsx as typeof reactJsx;
export const jsxs: typeof reactJsxs = jsxRuntime.jsxs as typeof reactJsxs;
export const Fragment: typeof ReactFragment = jsxRuntime.Fragment as typeof ReactFragment;
