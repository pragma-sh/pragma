import {
  defineAccounts,
  defineAgent,
  definePlugin,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

import { identifyCopilotAccount } from "./identity";
import { loadGitHubCopilotUsageLimits } from "./usage-limits";

export { identifyCopilotAccount, parseCopilotConfig } from "./identity";
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
  handleQuestionAnswers: true,
  questionOtherMode: "navigate",
  // Copilot's composer does not reliably decode synthetic bracketed-paste
  // markers, so inject watcher messages as ordinary text.
  interjectMode: "plain",
});

/** Pragma plugin for GitHub Copilot CLI. */
export const githubCopilotCliPlugin: PluginDefinition = definePlugin({
  name: "GitHub Copilot CLI",
  description: "Launch GitHub Copilot CLI from Pragma.",
  accounts: defineAccounts([
    {
      provider: "github-copilot",
      agent: "github-copilot",
      dashboardUrl: "https://github.com/settings/copilot",
      iconPath: "assets/copilot.png",
      login: {
        command: ["copilot", "login"],
        instructions: "Enter the code shown here on the GitHub page that opens.",
      },
      // `COPILOT_HOME` replaces all of `~/.copilot`: config, sessions, and the
      // plain-text token fallback when no system credential store exists.
      env: (home) => ({ COPILOT_HOME: home }),
      credentialPath: (home) => `System credential store, else ${home ?? "~/.copilot"}`,
      identify: identifyCopilotAccount,
      usageLimits: {
        primaryLimitId: "ai-credits",
        refreshIntervalMs: 60_000,
        load: loadGitHubCopilotUsageLimits,
      },
    },
  ]),
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
      excludeFeatures: ["abort", "interrupt"],
      // Copilot's interactive TUI mounts slowly on a cold start (skills,
      // hooks, and extensions load before the composer accepts input), so a
      // short fixed prefill is swallowed and the launch prompt is lost.
      prefillDelayMs: 25000,
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
