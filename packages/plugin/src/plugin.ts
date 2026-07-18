import type { AgentReportPayload } from "@pragma/constants";
import type { ZodType, ZodTypeAny } from "zod";
import type { AgentDefinition } from "./agent";
import type {
  CommandDefinition,
  PluginIcon,
  SidebarCardDefinition,
  SidebarTabDefinition,
  TopperItemDefinition,
  WebViewDefinition,
} from "./contributions";
import { PLUGIN_API_VERSION } from "./generated/version";
import type { PluginContext } from "./types";
import type { PluginDeepLinkEvent } from "./types";
import type { WatcherDefinition } from "./watcher";
import type { UsageLimitProviderDefinition } from "./usage-limits";

/** Infers a config schema's parsed output type, defaulting to `unknown` when no schema is given. */
export type InferConfig<TConfigSchema extends ZodTypeAny> =
  TConfigSchema extends ZodType<infer Output> ? Output : unknown;

/** UI surfaces a plugin can contribute to. */
export interface PluginUiContributions<TConfig = unknown> {
  sidebarTabs?: SidebarTabDefinition<TConfig>[];
  topper?: TopperItemDefinition<TConfig>[];
  sidebarCards?: SidebarCardDefinition<TConfig>[];
  webViews?: WebViewDefinition[];
}

/** Whether a plugin's declared values are merged with or replace host defaults. */
export type PluginContributionStrategy = "merge" | "replace";

/** Default settings values a plugin contributes. */
export interface PluginSettingsContributions {
  strategy?: PluginContributionStrategy;
  values: Record<string, unknown>;
}

/** Default keybindings a plugin contributes. */
export interface PluginKeybindingsContributions {
  strategy?: PluginContributionStrategy;
  bindings: Record<string, string>;
}

/** Daemon-forwarded events a plugin can subscribe to declaratively. */
export interface PluginEventHandlers<TConfig = unknown> {
  "agent.report"?: (event: AgentReportPayload, ctx: PluginContext<TConfig>) => void;
  deepLink?: (event: PluginDeepLinkEvent, ctx: PluginContext<TConfig>) => void;
}

/** The object shape passed to `definePlugin`. */
export interface PluginDefinitionInput<TConfigSchema extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description?: string;
  icon?: PluginIcon;
  config?: TConfigSchema;
  ui?: PluginUiContributions<InferConfig<TConfigSchema>>;
  agents?: AgentDefinition<InferConfig<TConfigSchema>>[];
  watchers?: WatcherDefinition<InferConfig<TConfigSchema>>[];
  commands?: CommandDefinition<InferConfig<TConfigSchema>>[];
  settings?: PluginSettingsContributions;
  keybindings?: PluginKeybindingsContributions;
  events?: PluginEventHandlers<InferConfig<TConfigSchema>>;
  usageLimits?: UsageLimitProviderDefinition<InferConfig<TConfigSchema>>[];
  css?: string;
  /** Runs once when Pragma first discovers this plugin installation. */
  onInstall?: (ctx: PluginContext<InferConfig<TConfigSchema>>) => void | Promise<void>;
  /** Runs once during every Pragma server boot. */
  onPragmaLoad?: (ctx: PluginContext<InferConfig<TConfigSchema>>) => void | Promise<void>;
  activate?: (ctx: PluginContext<InferConfig<TConfigSchema>>) => void | (() => void);
}

/**
 * A fully-declared plugin, as returned by `definePlugin`. `__apiVersion` is
 * stamped automatically — plugin authors never set it themselves, and it
 * lives under a deliberately internal-looking name so it doesn't show up as
 * something to configure.
 */
export interface PluginDefinition<
  TConfigSchema extends ZodTypeAny = ZodTypeAny,
> extends PluginDefinitionInput<TConfigSchema> {
  /** @internal The `@pragma/plugin` version this plugin was compiled against. */
  readonly __apiVersion: string;
}

/**
 * Declares a Pragma plugin. This is the single entry point a plugin's bundle
 * must default-export. Stamps the compiled-against `@pragma/plugin` version
 * onto the result so the host can check compatibility before loading it.
 */
export function definePlugin<TConfigSchema extends ZodTypeAny = ZodTypeAny>(
  input: PluginDefinitionInput<TConfigSchema>,
): PluginDefinition<TConfigSchema> {
  return { ...input, __apiVersion: PLUGIN_API_VERSION };
}
