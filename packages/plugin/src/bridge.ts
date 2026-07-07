import type { ButtonHTMLAttributes, ComponentType, HTMLAttributes, JSX } from "react";
import type { AgentMessage } from "@pragma/sdk";
import type { OpenWebViewOptions, WebViewReference } from "./contributions";
import type { PragmaHooksBridge } from "./hooks";

/** Minimal host Button props exposed through `@pragma/plugin/ui`. */
export type PragmaButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?:
    | "default"
    | "outline"
    | "secondary"
    | "ghost"
    | "destructive"
    | "success"
    | "warning"
    | "link";
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
};

/** Minimal host keyboard-badge props exposed through `@pragma/plugin/ui`. */
export type PragmaKbdProps = HTMLAttributes<HTMLElement>;

/** A rendered UI primitive contributed by the host (`@pragma/plugin/ui`). */
export interface PragmaUiBridge {
  Button: ComponentType<PragmaButtonProps>;
  Kbd: ComponentType<PragmaKbdProps>;
}

/** A rendered icon component contributed by the host (`@pragma/plugin/icons`). */
export type PragmaIconsBridge = Record<string, ComponentType<{ className?: string }>>;

/** Host actions exposed to plugin code outside React render trees. */
export interface PragmaActionsBridge {
  openWebView: <TPayload = unknown>(
    webView: WebViewReference<TPayload>,
    options?: OpenWebViewOptions<TPayload>,
  ) => Promise<void>;
  agents: {
    /** Reports one rich agent message through the host SDK bridge. */
    reportMessage: (message: AgentMessage) => Promise<void>;
  };
}

/**
 * The runtime surface the Pragma host installs at `globalThis.__PRAGMA__`
 * before any plugin bundle is imported. Every value here is a compile-time
 * stub in `@pragma/plugin` — the host supplies the real implementation so
 * plugin bundles never need to bundle React, zod, or host UI code themselves.
 */
export interface PragmaBridge {
  react: typeof import("react");
  reactDom: typeof import("react-dom");
  jsxRuntime: {
    jsx: (type: unknown, props: unknown, key?: unknown) => JSX.Element;
    jsxs: (type: unknown, props: unknown, key?: unknown) => JSX.Element;
    Fragment: unknown;
  };
  zod: typeof import("zod").z;
  ui: PragmaUiBridge;
  icons: PragmaIconsBridge;
  hooks: PragmaHooksBridge;
  actions: PragmaActionsBridge;
}

declare global {
  // eslint-disable-next-line no-var -- `var` is required to augment `globalThis`.
  var __PRAGMA__: PragmaBridge | undefined;
}

/**
 * Returns the host-installed Pragma bridge, throwing a clear error when a
 * plugin module runs outside a Pragma host (e.g. imported directly in a Node
 * script, a unit test, or a non-Pragma bundler build).
 */
export function getBridge(): PragmaBridge {
  const bridge = globalThis.__PRAGMA__;
  if (!bridge) {
    throw new Error(
      "@pragma/plugin: globalThis.__PRAGMA__ is not installed. This module only " +
        "runs inside a Pragma host, which installs the bridge before loading any " +
        "plugin bundle. It cannot be imported standalone (e.g. from Node or a " +
        "non-Pragma bundler build).",
    );
  }
  return bridge;
}
