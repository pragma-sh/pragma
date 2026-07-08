import { definePlugin, type AgentDefinition, type WatcherDefinition } from "@pragma/plugin";
import claudeCodeAgentPlugin from "@pragma/claude-code-plugin/pragma-agent";
import cursorAgentPlugin from "@pragma/cursor-plugin/pragma-agent";
import opencodeAgentPlugin from "@pragma/opencode-plugin/pragma-agent";

import type { PluginRecord } from "./registry";

/**
 * The agent definitions now live in their host-tool plugin packages
 * (`@pragma/{claude-code,cursor,opencode}-plugin/pragma-agent`) so the
 * `pragma-plugins` catalog sidecar and this webview path share one source of
 * truth. This module only re-wraps them for the in-webview plugin registry:
 * it overrides each `iconPath` with a browser URL (the webview renders icons as
 * `<img>`; the sidecar hashes them from disk) and attaches the built-in
 * watchers.
 */

/**
 * `mainPath` sentinel for built-in watchers. Built-in agents have no on-disk
 * plugin bundle, so the Rust side (`plugins.rs`) resolves this to the staged
 * `@pragma/opencode-plugin` watcher module the `pragma-watch` sidecar imports.
 */
const BUILTIN_OPENCODE_WATCHER_MAIN = "pragma-builtin:opencode-watcher";

/** Browser URLs for the built-in agent icons, resolved for the webview. */
const iconUrls: Record<string, string> = {
  "claude-code": new URL(
    "../../../../packages/claude-code-plugin/assets/claude-code.svg",
    import.meta.url,
  ).href,
  cursor: new URL("../../../../packages/cursor-plugin/assets/cursor.svg", import.meta.url).href,
  opencode: new URL("../../../../packages/opencode-plugin/assets/opencode.svg", import.meta.url)
    .href,
};

/**
 * Advertises that a built-in agent has a host-side watcher so the app starts one
 * on launch. These app-side stubs are never invoked and only carry the agent id
 * used to key the watcher.
 */
const builtinAgentWatcher = (agent: string): WatcherDefinition => ({ agent, watch: () => {} });

/** Re-points an imported agent definition's icon at its webview browser URL. */
function withBrowserIcon(agent: AgentDefinition): AgentDefinition {
  return { ...agent, iconPath: iconUrls[agent.id] ?? agent.iconPath };
}

const builtinAgents: AgentDefinition[] = [
  ...(claudeCodeAgentPlugin.agents ?? []),
  ...(opencodeAgentPlugin.agents ?? []),
  ...(cursorAgentPlugin.agents ?? []),
].map(withBrowserIcon);

const builtinAgentsPlugin = definePlugin({
  name: "Pragma Built-in Agents",
  description: "Built-in agent launchers for Claude Code, OpenCode, and Cursor Agent.",
  agents: builtinAgents,
  watchers: [
    builtinAgentWatcher("opencode"),
    builtinAgentWatcher("claude-code"),
    builtinAgentWatcher("cursor"),
  ],
});

export const builtinAgentRecords: PluginRecord[] = [
  {
    pluginId: "pragma.builtin-agents",
    version: "0.0.0",
    scope: "builtin",
    status: "loaded",
    config: undefined,
    mainPath: BUILTIN_OPENCODE_WATCHER_MAIN,
    definition: builtinAgentsPlugin,
  },
];
