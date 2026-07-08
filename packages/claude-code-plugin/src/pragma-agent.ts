import { defineAgent, definePlugin, type PluginDefinition } from "@pragma/plugin";

/** Absolute filesystem path to this plugin's agent icon. */
export const claudeCodeIconPath = new URL("../assets/claude-code.svg", import.meta.url).pathname;

const reasoningFull = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];
const reasoningStandard = reasoningFull.slice(0, 3);

/** Pragma agent contribution for Claude Code, loaded by the pragma-plugins sidecar. */
export const claudeCodeAgentPlugin: PluginDefinition = definePlugin({
  name: "Claude Code",
  description: "Launch Claude Code from Pragma.",
  agents: [
    defineAgent({
      id: "claude-code",
      name: "Claude Code",
      icon: () => null,
      iconPath: claudeCodeIconPath,
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
