import { Component as ReactComponent, type ErrorInfo, type ReactNode } from "react";

import type {
  PluginContext,
  PluginWhen,
  SidebarCardDefinition,
  SidebarTabDefinition,
  TopperItemDefinition,
  WebViewDefinition,
} from "@pragma/plugin";

import { PluginBoundary, notifyFromPlugin, usePluginRuntimeState } from "./host-hooks";
import { useActivePlugins, type PluginRecord } from "./registry";

/** A loaded plugin contribution tagged with the record that supplied it. */
export interface VisiblePluginContribution<T> {
  key: string;
  pluginId: string;
  record: PluginRecord;
  contribution: T;
}

/** Returns visible sidebar-tab contributions for the active project. */
export function usePluginSidebarTabs(
  activeProjectId: string | null,
): VisiblePluginContribution<SidebarTabDefinition>[] {
  return useVisibleContributions(activeProjectId, (definition) => definition.ui?.sidebarTabs);
}

/** Returns visible workspace topper-item contributions for the active project. */
export function usePluginTopperItems(
  activeProjectId: string | null,
  align?: "left" | "right",
): VisiblePluginContribution<TopperItemDefinition>[] {
  const items = useVisibleContributions(activeProjectId, (definition) => definition.ui?.topper);
  return align === undefined ? items : items.filter((item) => item.contribution.align === align);
}

/** Returns visible left-sidebar card contributions for the active project. */
export function usePluginSidebarCards(
  activeProjectId: string | null,
): VisiblePluginContribution<SidebarCardDefinition>[] {
  return useVisibleContributions(activeProjectId, (definition) => definition.ui?.sidebarCards);
}

/** Returns visible workspace web view contributions for the active project. */
export function usePluginWebViews(
  activeProjectId: string | null,
): VisiblePluginContribution<WebViewDefinition>[] {
  return useVisibleContributions(activeProjectId, (definition) => definition.ui?.webViews);
}

function useVisibleContributions<TContribution extends object>(
  activeProjectId: string | null,
  select: (definition: NonNullable<PluginRecord["definition"]>) => TContribution[] | undefined,
): VisiblePluginContribution<TContribution>[] {
  const records = useActivePlugins(activeProjectId);
  const runtime = usePluginRuntimeState();
  const contributions: VisiblePluginContribution<TContribution>[] = [];
  for (const record of records) {
    if (record.status !== "loaded" || !record.definition) {
      continue;
    }
    let index = 0;
    for (const contribution of select(record.definition) ?? []) {
      const when =
        "when" in contribution ? (contribution.when as PluginWhen<unknown> | undefined) : undefined;
      if (!shouldShow(record, when, runtime)) {
        index += 1;
        continue;
      }
      contributions.push({
        key: contributionKey(record, contribution, index),
        pluginId: record.pluginId,
        record,
        contribution,
      });
      index += 1;
    }
  }
  return contributions;
}

function contributionKey(record: PluginRecord, contribution: object, index: number): string {
  const id =
    "id" in contribution
      ? String(contribution.id)
      : "title" in contribution
        ? String(contribution.title)
        : String(index);
  return `${record.pluginId}:${id}`;
}

type PluginRuntime = ReturnType<typeof usePluginRuntimeState>;

function shouldShow<TConfig>(
  record: PluginRecord,
  when: PluginWhen<TConfig> | undefined,
  runtime: PluginRuntime,
): boolean {
  if (!when) {
    return true;
  }
  if (!runtime.sdk) {
    return false;
  }
  try {
    return Boolean(when(pluginContext(record, runtime) as PluginContext<TConfig>));
  } catch (cause) {
    console.error(`plugin "${record.pluginId}" contribution guard threw`, cause);
    return false;
  }
}

function pluginContext(record: PluginRecord, runtime: PluginRuntime): PluginContext {
  if (!runtime.sdk) {
    throw new Error("Plugin SDK is not connected yet");
  }
  return {
    pluginId: record.pluginId,
    config: record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
  };
}

interface PluginErrorBoundaryProps {
  pluginId: string;
  resetKey: string;
  children: ReactNode;
}

interface PluginErrorBoundaryState {
  error: string | null;
}

class PluginErrorBoundary extends ReactComponent<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  state: PluginErrorBoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): PluginErrorBoundaryState {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  componentDidCatch(cause: unknown, info: ErrorInfo): void {
    console.error(`plugin "${this.props.pluginId}" component crashed`, cause, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-medium">Plugin "{this.props.pluginId}" crashed.</p>
          <p className="mt-1 break-words text-destructive/80">{this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Renders a plugin component with per-plugin config and crash isolation. */
export function RenderPluginContribution(props: {
  pluginId: string;
  config: unknown;
  webViewPayload?: unknown;
  resetKey: string;
  component: () => ReactNode;
}): ReactNode {
  const PluginComponent = props.component;
  return (
    <PluginErrorBoundary key={props.resetKey} pluginId={props.pluginId} resetKey={props.resetKey}>
      <PluginBoundary
        config={props.config}
        pluginId={props.pluginId}
        webViewPayload={props.webViewPayload}
      >
        <PluginComponent />
      </PluginBoundary>
    </PluginErrorBoundary>
  );
}
