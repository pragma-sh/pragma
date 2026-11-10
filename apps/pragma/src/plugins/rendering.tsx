import { Component as ReactComponent, type ErrorInfo, type ReactNode } from "react";

import type {
  PluginContext,
  PluginComponent,
  PluginWhen,
  SettingsPageDefinition,
  SidebarCardDefinition,
  SidebarTabDefinition,
  TopperItemDefinition,
  WorktreeSectionDefinition,
  PluginWorktree,
} from "@pragma-sh/plugin";

import { CountProbe } from "@/lib/count-probe";
import {
  PluginBoundary,
  notifyFromPlugin,
  pluginStorageFor,
  usePluginRuntimeState,
} from "./host-hooks";
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

/** Returns visible Settings-page contributions for the selected settings scope. */
export function usePluginSettingsPages(
  activeProjectId: string | null,
): VisiblePluginContribution<SettingsPageDefinition>[] {
  return useVisibleContributions(activeProjectId, (definition) => definition.ui?.settingsPages);
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

/**
 * Returns the worktree-section contributions visible on one worktree row; each
 * `when` guard sees that row as `ctx.worktree`.
 */
export function usePluginWorktreeSections(
  activeProjectId: string | null,
  worktree: PluginWorktree,
): VisiblePluginContribution<WorktreeSectionDefinition>[] {
  return useVisibleContributions(activeProjectId, (definition) => definition.ui?.worktreeSections, {
    worktree,
  });
}

function useVisibleContributions<TContribution extends object>(
  activeProjectId: string | null,
  select: (definition: NonNullable<PluginRecord["definition"]>) => TContribution[] | undefined,
  guardContext?: object,
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
      if (!shouldShow(record, when, runtime, guardContext)) {
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
  return `${record.scope}:${record.projectId ?? ""}:${record.pluginId}:${id}`;
}

type PluginRuntime = ReturnType<typeof usePluginRuntimeState>;

function shouldShow<TConfig>(
  record: PluginRecord,
  when: PluginWhen<TConfig> | undefined,
  runtime: PluginRuntime,
  guardContext?: object,
): boolean {
  if (!when) {
    return true;
  }
  if (!runtime.sdk) {
    return false;
  }
  try {
    const ctx = { ...pluginContextForRecord(record, runtime), ...guardContext };
    return Boolean(when(ctx as PluginContext<TConfig>));
  } catch (cause) {
    console.error(`plugin "${record.pluginId}" contribution guard threw`, cause);
    return false;
  }
}

/** Builds callback context for a loaded plugin record. */
function pluginContextForRecord(record: PluginRecord, runtime: PluginRuntime): PluginContext {
  if (!runtime.sdk) {
    throw new Error("Plugin SDK is not connected yet");
  }
  return {
    pluginId: record.pluginId,
    ...(record.dir === undefined ? {} : { pluginDir: record.dir }),
    config: record.config,
    project: runtime.project,
    sdk: runtime.sdk,
    notify: notifyFromPlugin,
    storage: pluginStorageFor(record.pluginId),
  };
}

interface PluginErrorBoundaryProps {
  pluginId: string;
  resetKey: string;
  /** Rendered in place of a crashed subtree; defaults to the inline crash notice. */
  fallback?: ReactNode;
  children: ReactNode;
}

interface PluginErrorBoundaryState {
  error: string | null;
  resetKey: string;
}

class PluginErrorBoundary extends ReactComponent<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  state: PluginErrorBoundaryState = { error: null, resetKey: "" };

  static getDerivedStateFromProps(
    props: PluginErrorBoundaryProps,
    state: PluginErrorBoundaryState,
  ): Partial<PluginErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  static getDerivedStateFromError(cause: unknown): Partial<PluginErrorBoundaryState> {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  componentDidCatch(cause: unknown, info: ErrorInfo): void {
    console.error(`plugin "${this.props.pluginId}" component crashed`, cause, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }
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

/**
 * Renders a plugin component with per-plugin config and crash isolation.
 *
 * The boundary resets on gateway connectivity as well as the caller's reset
 * key: the gateway spawns lazily, so a contribution that calls `useSdk` during
 * that window throws, and without this the boundary would latch that startup
 * transient for the rest of the session even though the SDK arrives seconds
 * later. The reset clears the caught error without remounting healthy child
 * subtrees — only a contribution that actually crashed is rendered afresh, so
 * component-local state and mount effects in working plugins survive the
 * startup connectivity flip.
 */
export function RenderPluginContribution(props: {
  pluginId: string;
  config: unknown;
  webViewPayload?: unknown;
  /** The row a worktree section renders under, exposed through `useWorktree()`. */
  worktree?: PluginWorktree;
  resetKey: string;
  component: PluginComponent;
}): ReactNode {
  const PluginComponent = props.component;
  return (
    <PluginSubtree {...props}>
      <PluginComponent webViewPayload={props.webViewPayload} />
    </PluginSubtree>
  );
}

/**
 * Runs a plugin's `useCount` hook inside that plugin's boundary and reports its
 * result. A count hook that throws reports nothing and renders nothing, which
 * hides its contribution instead of drawing a crash notice for a badge.
 */
export function RenderPluginCount<TArgs extends unknown[]>(props: {
  pluginId: string;
  config: unknown;
  worktree?: PluginWorktree;
  resetKey: string;
  useCount: (...args: TArgs) => number | null;
  args: TArgs;
  onCount: (count: number | null) => void;
}): ReactNode {
  return (
    <PluginSubtree {...props} fallback={null}>
      <CountProbe args={props.args} onCount={props.onCount} useCount={props.useCount} />
    </PluginSubtree>
  );
}

/** The error boundary plus per-plugin context every plugin subtree renders inside. */
function PluginSubtree(props: {
  pluginId: string;
  config: unknown;
  webViewPayload?: unknown;
  worktree?: PluginWorktree;
  resetKey: string;
  fallback?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const connected = usePluginRuntimeState().sdk !== null;
  const resetKey = `${props.resetKey}:${connected ? "sdk" : "no-sdk"}`;
  return (
    <PluginErrorBoundary fallback={props.fallback} pluginId={props.pluginId} resetKey={resetKey}>
      <PluginBoundary
        config={props.config}
        pluginId={props.pluginId}
        webViewPayload={props.webViewPayload}
        worktree={props.worktree}
      >
        {props.children}
      </PluginBoundary>
    </PluginErrorBoundary>
  );
}
