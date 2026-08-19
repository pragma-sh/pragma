import type { ComponentType, ReactNode } from "react";
import { getBridge } from "./bridge";
import type { PluginContext } from "./types";

/** An icon contributed alongside a sidebar tab, command, or agent. */
export type PluginIcon = ComponentType<{ className?: string }>;

/** Values passed directly to every host-rendered plugin component. */
export interface PluginComponentProps<TWebViewPayload = unknown> {
  /** Payload supplied when this component renders as a plugin web view. */
  webViewPayload?: TWebViewPayload;
}

/** A host-rendered plugin component. Hooks remain available for reactive host state. */
export type PluginComponent<TWebViewPayload = unknown> = {
  bivarianceHack(props: PluginComponentProps<TWebViewPayload>): ReactNode;
}["bivarianceHack"];

/** A guard evaluated by the host to decide whether a contribution should render. */
export type PluginWhen<TConfig = unknown> = (ctx: PluginContext<TConfig>) => boolean;

/** A tab contributed to the project sidebar. */
export interface SidebarTabDefinition<TConfig = unknown> {
  id: string;
  title: string;
  icon?: PluginIcon;
  component: PluginComponent;
  when?: PluginWhen<TConfig>;
}

/** Declares a sidebar tab contribution. */
export function defineSidebarTab<TConfig = unknown>(
  input: SidebarTabDefinition<TConfig>,
): SidebarTabDefinition<TConfig> {
  return input;
}

/** A page contributed to Pragma Settings. */
export interface SettingsPageDefinition<TConfig = unknown> {
  id: string;
  title: string;
  icon?: PluginIcon;
  component: PluginComponent;
  when?: PluginWhen<TConfig>;
}

/** Declares a React page contribution for Pragma Settings. */
export function defineSettingsPage<TConfig = unknown>(
  input: SettingsPageDefinition<TConfig>,
): SettingsPageDefinition<TConfig> {
  return input;
}

/** Options used when opening a plugin web view tab. */
export interface OpenWebViewOptions<TPayload = unknown> {
  /** Overrides the tab title; falls back to the web view title, then id. */
  title?: string;
  /** JSON-serializable data made available through `useWebViewPayload`. */
  payload?: TPayload;
  /** Stable key used by the host to focus an existing matching web view tab. */
  dedupeKey?: string;
}

/** A plugin-defined React view that renders inside a workspace tab web view. */
export interface WebViewDefinition<TPayload = unknown> {
  id: string;
  title?: string;
  component: PluginComponent<TPayload>;
  /** Opens this web view as a workspace tab. */
  open(options?: OpenWebViewOptions<TPayload>): Promise<void>;
}

/** Input accepted by `defineWebView`; the returned definition adds `.open()`. */
export type WebViewDefinitionInput<TPayload = unknown> = Omit<WebViewDefinition<TPayload>, "open">;

/** Reference accepted by `openWebView`: a web view handle or a unique web view id. */
export type WebViewReference<TPayload = unknown> = WebViewDefinition<TPayload> | string;

/** Opens a plugin web view tab by handle, or by id when the id is unambiguous. */
export function openWebView<TPayload = unknown>(
  webView: WebViewReference<TPayload>,
  options?: OpenWebViewOptions<TPayload>,
): Promise<void> {
  return getBridge().actions.openWebView(webView, options);
}

/** Declares a plugin web view contribution. */
export function defineWebView<TPayload = unknown>(
  input: WebViewDefinitionInput<TPayload>,
): WebViewDefinition<TPayload> {
  const definition: WebViewDefinition<TPayload> = {
    ...input,
    open: (options) => openWebView(definition, options),
  };
  return definition;
}

/** An item contributed to the workspace topper bar. */
export interface TopperItemDefinition<TConfig = unknown> {
  align: "left" | "right";
  component: PluginComponent;
  when?: PluginWhen<TConfig>;
}

/** Declares a topper-bar item contribution. */
export function defineTopperItem<TConfig = unknown>(
  input: TopperItemDefinition<TConfig>,
): TopperItemDefinition<TConfig> {
  return input;
}

/** A card contributed to the project sidebar. */
export interface SidebarCardDefinition<TConfig = unknown> {
  title: string;
  component: PluginComponent;
  when?: PluginWhen<TConfig>;
}

/** Declares a sidebar card contribution. */
export function defineSidebarCard<TConfig = unknown>(
  input: SidebarCardDefinition<TConfig>,
): SidebarCardDefinition<TConfig> {
  return input;
}

/** A command contributed to the command palette / keybindings surface. */
export interface CommandDefinition<TConfig = unknown> {
  id: string;
  title: string;
  icon?: PluginIcon;
  defaultBinding?: string;
  hidden?: boolean;
  run: (ctx: PluginContext<TConfig>, args?: unknown) => void | Promise<void>;
}

/** Declares a command contribution. */
export function defineCommand<TConfig = unknown>(
  input: CommandDefinition<TConfig>,
): CommandDefinition<TConfig> {
  return input;
}
