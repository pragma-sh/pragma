import * as react from "react";
import * as reactDom from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as lucideIcons from "lucide-react";
import { z } from "zod";

import type { PragmaBridge } from "@pragma/plugin";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { hostHooks } from "./host-hooks";
import { openRegisteredWebView } from "./webviews";

declare global {
  // eslint-disable-next-line no-var -- `var` is required to augment `globalThis`.
  var __PRAGMA__: PragmaBridge | undefined;
}

/**
 * Installs `globalThis.__PRAGMA__` — the runtime surface plugin bundles
 * delegate to for React, ReactDOM, the JSX runtime, zod, UI primitives,
 * icons, and hooks. Must run before any plugin bundle is imported (main.tsx
 * calls it before the first render). Idempotent.
 *
 * `ui` starts with a deliberately small stable surface; add primitives here
 * only when plugin authors should be able to rely on them.
 */
export function installPragmaBridge(): void {
  if (globalThis.__PRAGMA__) {
    return;
  }
  globalThis.__PRAGMA__ = {
    react,
    reactDom,
    // The bridge declares jsx/jsxs with `unknown` params so plugin bundles
    // stay decoupled from React's types; the real runtime satisfies it.
    jsxRuntime: jsxRuntime as unknown as PragmaBridge["jsxRuntime"],
    zod: z,
    ui: { Button, Kbd } as PragmaBridge["ui"],
    icons: lucideIcons as unknown as PragmaBridge["icons"],
    hooks: hostHooks,
    actions: { openWebView: openRegisteredWebView },
  };
}
