import {
  defineAgent,
  definePlugin,
  defineUsageLimitProvider,
  type PluginDefinition,
} from "@pragma/plugin/catalog";
import { createTuiWatcher } from "@pragma/watcher-kit";

import { loadGitHubCopilotUsageLimits } from "./usage-limits";

export { loadGitHubCopilotUsageLimits, parseGitHubCopilotUsageLimits } from "./usage-limits";

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({
  id,
  name: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}`,
}));
const MODELS = [
  "gpt-5-mini",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
  "claude-opus-4.8",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "kimi-k2.7-code",
].map((id) => ({ id, name: modelName(id), reasoning: REASONING_LEVELS }));
const baseWatcher = createTuiWatcher({
  agent: "github-copilot",
  handleDecisions: false,
  handleQuestionAnswers: false,
});

/** Pragma plugin for GitHub Copilot CLI. */
export const githubCopilotCliPlugin: PluginDefinition = definePlugin({
  name: "GitHub Copilot CLI",
  description: "Launch GitHub Copilot CLI from Pragma.",
  usageLimits: [
    defineUsageLimitProvider({
      id: "github-copilot",
      title: "GitHub Copilot",
      dashboardUrl: "https://github.com/settings/copilot",
      iconPath: "assets/copilot.png",
      primaryLimitId: "ai-credits",
      refreshIntervalMs: 60_000,
      load: loadGitHubCopilotUsageLimits,
    }),
  ],
  watchers: [
    {
      agent: "github-copilot",
      async watch(ctx) {
        try {
          await baseWatcher.watch(ctx);
        } finally {
          try {
            await ctx.sdk.agents.report({
              agent: ctx.agentId,
              tabId: ctx.session.tabId,
              worktreeId: ctx.session.worktreeId,
              status: "cleared",
              attentionKind: null,
            });
          } catch {
            // Session-exit cleanup must never disrupt watcher shutdown.
          }
        }
      },
    },
  ],
  agents: [
    defineAgent({
      id: "github-copilot",
      name: "GitHub Copilot CLI",
      icon: () => null,
      iconPath: "assets/copilot.png",
      launch: { command: ["copilot", "--no-auto-update"] },
      excludeFeatures: ["questions", "abort", "interrupt"],
      prefillDelayMs: 3000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: MODELS,
      permissionModes: [
        { id: "ask", name: "Ask" },
        { id: "allow-all", name: "Allow all" },
      ],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--effort", reasoningId],
        modelReasoning: (modelId: string, reasoningId: string) => [
          "--model",
          modelId,
          "--effort",
          reasoningId,
        ],
        permissionMode: (permissionModeId: string) =>
          permissionModeId === "allow-all" ? ["--allow-all"] : [],
      },
    }),
  ],
});

export default githubCopilotCliPlugin;

function modelName(id: string): string {
  return id
    .split("-")
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^\d/.test(part)) return part;
      return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
    })
    .join(" ");
}
