import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import { toast } from "sonner";

import { PragmaClient } from "@pragma/sdk";

import { PLUGIN_DEEP_LINK_EVENT, type PluginDeepLinkDetail } from "@/lib/deep-link";
import { onAgentReport, readPluginManifests, gatewayConnectionInfo } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";
import { emitPluginEvent } from "./events";
import {
  notifyFromPlugin,
  setPluginRuntimeProject,
  setPluginRuntimeSdk,
  usePluginRuntimeState,
} from "./host-hooks";
import { invalidatePluginModule, loadPluginEntries } from "./loader";
import { setPluginsForScope, type PluginRecord, useActivePlugins } from "./registry";
import { syncPluginCss } from "./css";
import { PluginCommandKeybindings } from "./commands";
import { setPluginAgents } from "./agents";
import { builtinAgentRecords } from "./builtin-agents";
import { setPluginWatchers } from "./watchers";
import { setPluginWebViewOpener, setPluginWebViews } from "./webviews";

/** How often dev mode polls plugin bundles for changes (hot-reload). */
const DEV_RELOAD_POLL_MS = 2000;

/**
 * Loads configured plugins and keeps the plugin runtime in sync with the app:
 *
 * - startup + project switch: reads `.pragma/config.json` entries (built-in
 *   seam first, then global, then active project) and loads them in order;
 * - publishes the active project and the gateway SDK client to the hooks
 *   bridge;
 * - forwards agent reports onto the plugin event bus (`"agent.report"`);
 * - dev only: polls bundle mtimes and hot-reloads changed plugins.
 *
 * Loaded modules are cached per path+version for the app run, so switching
 * projects re-evaluates cheaply without re-importing bundles.
 */
export function PluginProvider(props: { children: ReactNode }): ReactNode {
  const { projects, selectedProjectId, openPluginWebView } = useWorkspace();
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedPath = selectedProject?.path ?? null;
  const activePlugins = useActivePlugins(selectedProjectId);
  const runtime = usePluginRuntimeState();
  const manifestSignature = useRef<string | null>(null);

  useBuiltinPluginRegistry();
  useRuntimeProject(selectedProject);
  useRuntimeSdk();
  useAgentReportForwarding(activePlugins, runtime);
  useDeepLinkForwarding(activePlugins, runtime);
  usePluginContributionRegistries(activePlugins, runtime, openPluginWebView);
  usePluginLoading(projects, selectedPath, manifestSignature);
  usePluginDevReload(projects, selectedPath, manifestSignature);

  return (
    <>
      <PluginCommandKeybindings activeProjectId={selectedProjectId} />
      {props.children}
    </>
  );
}

function useBuiltinPluginRegistry(): void {
  useEffect(() => {
    setPluginsForScope("builtin", null, builtinAgentRecords);
  }, []);
}

function useRuntimeProject(project: { id: string; name: string; path: string } | null): void {
  useEffect(() => {
    setPluginRuntimeProject(
      project ? { id: project.id, name: project.name, path: project.path } : null,
    );
  }, [project]);
}

/** How long to wait before re-trying the gateway connection at startup. */
const SDK_CONNECT_RETRY_MS = 2000;

function useRuntimeSdk(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const connect = () => {
      gatewayConnectionInfo()
        .then((info) => {
          if (!cancelled) {
            setPluginRuntimeSdk(new PragmaClient({ baseUrl: info.baseUrl, token: info.token }));
          }
          return undefined;
        })
        .catch((cause: unknown) => {
          // The gateway spawns lazily; keep retrying so a slow first spawn
          // (common in release builds) doesn't leave plugins without an SDK
          // for the whole session.
          console.warn("plugin SDK bridge: gateway unavailable, retrying", cause);
          if (!cancelled) {
            timer = window.setTimeout(connect, SDK_CONNECT_RETRY_MS);
          }
        });
    };
    connect();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);
}

function useAgentReportForwarding(
  activePlugins: readonly PluginRecord[],
  runtime: ReturnType<typeof usePluginRuntimeState>,
): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void onAgentReport((payload) => {
      emitPluginEvent("agent.report", payload);
      runDeclarativePluginEvent(activePlugins, runtime, "agent.report", payload);
    }).then((stop) => {
      if (cancelled) {
        stop();
        return undefined;
      }
      unlisten = stop;
      return undefined;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activePlugins, runtime]);
}

function useDeepLinkForwarding(
  activePlugins: readonly PluginRecord[],
  runtime: ReturnType<typeof usePluginRuntimeState>,
): void {
  useEffect(() => {
    function onPluginDeepLink(event: Event): void {
      const payload = (event as CustomEvent<PluginDeepLinkDetail>).detail;
      emitPluginEvent("deepLink", payload);
      runDeclarativePluginEvent(activePlugins, runtime, "deepLink", payload);
    }
    window.addEventListener(PLUGIN_DEEP_LINK_EVENT, onPluginDeepLink);
    return () => window.removeEventListener(PLUGIN_DEEP_LINK_EVENT, onPluginDeepLink);
  }, [activePlugins, runtime]);
}

function usePluginContributionRegistries(
  activePlugins: readonly PluginRecord[],
  runtime: ReturnType<typeof usePluginRuntimeState>,
  openPluginWebView: NonNullable<Parameters<typeof setPluginWebViewOpener>[0]>,
): void {
  useEffect(() => {
    setPluginAgents(activePlugins, runtime);
  }, [activePlugins, runtime]);
  useEffect(() => {
    setPluginWatchers(activePlugins);
  }, [activePlugins]);
  useEffect(() => {
    setPluginWebViews(activePlugins);
  }, [activePlugins]);
  useEffect(() => {
    setPluginWebViewOpener(openPluginWebView);
    return () => setPluginWebViewOpener(null);
  }, [openPluginWebView]);
}

function usePluginLoading(
  projects: ReadonlyArray<{ id: string; path: string }>,
  selectedPath: string | null,
  manifestSignature: MutableRefObject<string | null>,
): void {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const evaluated = await evaluatePlugins(projects, selectedPath);
      if (!cancelled) {
        manifestSignature.current = evaluated;
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [projects, selectedPath, manifestSignature]);
}

function usePluginDevReload(
  projects: ReadonlyArray<{ id: string; path: string }>,
  selectedPath: string | null,
  manifestSignature: MutableRefObject<string | null>,
): void {
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    const interval = window.setInterval(() => {
      void reloadChangedPlugins(projects, selectedPath, manifestSignature);
    }, DEV_RELOAD_POLL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [projects, selectedPath, manifestSignature]);
}

async function reloadChangedPlugins(
  projects: ReadonlyArray<{ id: string; path: string }>,
  selectedPath: string | null,
  manifestSignature: MutableRefObject<string | null>,
): Promise<void> {
  const entries = await readPluginManifests(selectedPath).catch(() => null);
  if (entries === null) {
    return;
  }
  const signature = signatureOf(entries.map((entry) => manifestFingerprint(entry)));
  if (manifestSignature.current === null || signature === manifestSignature.current) {
    return;
  }
  for (const entry of entries) {
    if (entry.manifest) {
      invalidatePluginModule(entry.manifest.mainPath);
    }
  }
  manifestSignature.current = await evaluatePlugins(projects, selectedPath);
}

function runDeclarativePluginEvent(
  records: readonly PluginRecord[],
  runtime: ReturnType<typeof usePluginRuntimeState>,
  eventName: "agent.report" | "deepLink",
  payload: unknown,
): void {
  if (!runtime.sdk) {
    return;
  }
  for (const record of records) {
    const handler = record.status === "loaded" ? record.definition?.events?.[eventName] : undefined;
    if (!handler) {
      continue;
    }
    try {
      handler(payload as never, {
        pluginId: record.pluginId,
        config: record.config,
        project: runtime.project,
        sdk: runtime.sdk,
        notify: notifyFromPlugin,
      });
    } catch (cause) {
      console.error(`plugin "${record.pluginId}" ${eventName} handler threw`, cause);
    }
  }
}

interface ManifestEntryLike {
  specifier: string;
  scope: "global" | "project";
  error: string | null;
  config: Record<string, unknown> | null;
  manifest: { mainPath: string; version: string; modifiedMs: number | null } | null;
}

function manifestFingerprint(entry: ManifestEntryLike): string {
  return [
    entry.scope,
    entry.specifier,
    entry.error ?? "",
    JSON.stringify(entry.config ?? null),
    entry.manifest?.mainPath ?? "",
    entry.manifest?.version ?? "",
    String(entry.manifest?.modifiedMs ?? ""),
  ].join("\0");
}

function signatureOf(fingerprints: string[]): string {
  return fingerprints.join("\n");
}

/**
 * Reads config entries and loads them into the registry: global entries under
 * the `"global"` scope, active-project entries under that project's scope
 * group. Returns the manifest-set signature used for dev change polling.
 */
async function evaluatePlugins(
  projects: ReadonlyArray<{ id: string; path: string }>,
  selectedPath: string | null,
): Promise<string | null> {
  let entries;
  try {
    const result = await readPluginManifests(selectedPath);
    // Defensive: a mocked/misbehaving IPC layer may not return an array.
    entries = Array.isArray(result) ? result : [];
  } catch (cause) {
    console.error("failed to read plugin manifests", cause);
    return null;
  }
  const records = await loadPluginEntries(entries, {
    projectIdByPath: (projectPath) => projects.find((project) => project.path === projectPath)?.id,
    onFailure: notifyPluginFailure,
  });
  setPluginsForScope(
    "global",
    null,
    records.filter((record) => record.scope === "global"),
  );
  if (selectedPath !== null) {
    setPluginsForScope(
      "project",
      selectedPath,
      records.filter((record) => record.scope === "project"),
    );
  }
  syncPluginCss(records);
  return signatureOf(entries.map((entry) => manifestFingerprint(entry)));
}

function notifyPluginFailure(record: PluginRecord): void {
  toast.error(`Plugin "${record.pluginId}" failed to load`, {
    description: record.error,
  });
}
