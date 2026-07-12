import { defineAgent, definePlugin, type PluginDefinition } from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

/** Lets Claude Code's paste-aware TUI commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;

const reasoningFull = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];
const reasoningStandard = reasoningFull.slice(0, 3);

/**
 * Pragma plugin for Claude Code, bundled to `dist/pragma-plugin.mjs` and loaded
 * by the pragma-plugins sidecar, the desktop webview, and the `pragma-watch`
 * sidecar alike. Approvals go through Claude Code's blocking `await-decision`
 * hook, so the watcher only delivers interjections (`handleDecisions: false`).
 */
export const claudeCodeAgentPlugin: PluginDefinition = definePlugin({
  name: "Claude Code",
  description: "Launch Claude Code from Pragma.",
  watchers: [
    createTuiWatcher({
      agent: "claude-code",
      handleDecisions: false,
      interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
    }),
  ],
  agents: [
    defineAgent({
      id: "claude-code",
      name: "Claude Code",
      icon: () => null,
      iconPath: "assets/claude-code.svg",
      launch: { command: ["claude", "--permission-mode", "auto"] },
      models: [
        { id: "sonnet", name: "Sonnet", reasoning: reasoningFull },
        { id: "opus", name: "Opus", reasoning: reasoningStandard },
        { id: "fable", name: "Fable", reasoning: reasoningFull },
        { id: "haiku", name: "Haiku", reasoning: reasoningStandard },
      ],
      permissionModes: [],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--effort", reasoningId],
        permissionMode: () => [],
      },
    }),
  ],
});

export default claudeCodeAgentPlugin;
