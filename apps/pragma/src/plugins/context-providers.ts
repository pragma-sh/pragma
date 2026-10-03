import { useMemo } from "react";

import type {
  ContextItem,
  ContextProviderDefinition,
  ContextResolveInput,
  ContextSearchInput,
  PluginContext,
  PluginIcon,
} from "@pragma-sh/plugin";

import { BUILTIN_CONTEXT_PROVIDERS } from "@/lib/builtin-context-providers";

import { resolvePluginAssetPath } from "./assets";
import { notifyFromPlugin, usePluginRuntimeState } from "./host-hooks";
import { useActivePlugins, type PluginRecord } from "./registry";

/** A context provider bound to its plugin context, ready for the `@` picker. */
export interface ActiveContextProvider {
  /** Unique across providers: `builtin:<id>` or `<pluginId>:<id>`. */
  key: string;
  title: string;
  icon: PluginIcon | null;
  /** Browser URL of the provider's image, when it declares `iconPath`. */
  iconUrl: string | null;
  /** Browser URL of one item's own image, when it declares `iconPath`. */
  itemIconUrl: (item: ContextItem) => string | null;
  search: (input: ContextSearchInput) => Promise<ContextItem[]>;
  resolve: (input: ContextResolveInput) => Promise<string>;
}

/** Binds built-in and plugin providers for the prompt fields. Built-ins come first. */
function bindContextProviders(
  records: readonly PluginRecord[],
  runtime: Pick<PluginContext, "sdk" | "project"> | null,
): ActiveContextProvider[] {
  const bound = BUILTIN_CONTEXT_PROVIDERS.map((provider) =>
    bindProvider(`builtin:${provider.id}`, provider, null, () => null),
  );
  if (!runtime) return bound;
  for (const record of records) bound.push(...bindPluginProviders(record, runtime));
  return bound;
}

/** Bind one loaded plugin's providers with its scoped runtime and asset paths. */
function bindPluginProviders(
  record: PluginRecord,
  runtime: Pick<PluginContext, "sdk" | "project">,
): ActiveContextProvider[] {
  if (record.status !== "loaded" || !record.definition) return [];
  const ctx: PluginContext = {
    pluginId: record.pluginId,
    ...(record.dir === undefined ? {} : { pluginDir: record.dir }),
    config: record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  };
  return (record.definition.contextProviders ?? [])
    .filter((provider) => !provider.when || provider.when(ctx))
    .map((provider) =>
      bindProvider(`${record.pluginId}:${provider.id}`, provider, ctx, (path) =>
        resolvePluginAssetPath(path, record),
      ),
    );
}

function bindProvider(
  key: string,
  provider: ContextProviderDefinition,
  ctx: PluginContext | null,
  assetUrl: (path: string | undefined) => string | null,
): ActiveContextProvider {
  // Built-ins ignore their context argument; plugins always receive a real one.
  const context = ctx ?? ({} as PluginContext);
  return {
    key,
    title: provider.title,
    icon: provider.icon ?? null,
    iconUrl: assetUrl(provider.iconPath),
    itemIconUrl: (item) => assetUrl(item.iconPath),
    search: async (input) => provider.search(input, context),
    resolve: async (input) => provider.resolve(input, context),
  };
}

/** React hook: the context providers visible to the active project. */
export function useContextProviders(activeProjectId: string | null): ActiveContextProvider[] {
  const records = useActivePlugins(activeProjectId);
  const runtime = usePluginRuntimeState();
  return useMemo(
    () =>
      bindContextProviders(
        records,
        runtime.sdk ? { sdk: runtime.sdk, project: runtime.project } : null,
      ),
    [records, runtime.sdk, runtime.project],
  );
}
