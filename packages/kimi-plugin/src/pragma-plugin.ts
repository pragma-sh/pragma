import {
  defineAgent,
  definePlugin,
  modeProvider,
  slashCommandProvider,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

import { loadKimiModels } from "./models";

/** Lets Kimi's paste-aware composer commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;
/** Kimi paints its TUI within a couple of seconds of launch; type after it. */
const PREFILL_DELAY_MS = 2500;

/** Kimi built-ins worth starting a session with; skills and commands are discovered. */
const BUILTIN_SLASH_COMMANDS = [
  { name: "init", description: "Analyze the project and write AGENTS.md" },
  { name: "compact", description: "Compact the conversation context" },
];
/** Kimi invokes skills as `/skill:<name>`; Claude Code commands keep their name. */
const SLASH_COMMAND_SOURCES = [
  { dir: ".kimi-code/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: ".agents/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: ".claude/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: ".claude/commands", layout: "files" as const },
  { dir: "~/.kimi-code/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: "~/.agents/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: "~/.claude/skills", layout: "skills" as const, prefix: "skill:" },
  { dir: "~/.claude/commands", layout: "files" as const },
];
/** Agent profiles selected with `--agent <name>`. */
const AGENT_SOURCES = [
  { dir: ".kimi-code/agents", layout: "files" as const, nameFromFrontmatter: true },
  { dir: ".agents/agents", layout: "files" as const, nameFromFrontmatter: true },
  { dir: "~/.kimi-code/agents", layout: "files" as const, nameFromFrontmatter: true },
  { dir: "~/.agents/agents", layout: "files" as const, nameFromFrontmatter: true },
];
const DEFAULT_MODE = "default";

const baseWatcher = createTuiWatcher({
  agent: "kimi",
  // Kimi command approvals cannot be brokered, but AskUserQuestion is reported
  // by the hook and answered through Kimi's native question dialog.
  handleDecisions: false,
  handleQuestionAnswers: true,
  questionFinalizeKeys: "1",
  interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
});

/**
 * Pragma plugin for the Kimi Code CLI, bundled to `dist/pragma-plugin.mjs`.
 *
 * Lifecycle reporting is a declarative hook bundle (`kimi.plugin.json` ->
 * `hooks/report.sh`) installed into Kimi through its own `/plugins install`
 * mechanism, because Kimi loads no in-process JavaScript plugin and its only
 * live extension point is shell-command hooks. This module contributes only
 * the Pragma-side launcher, model provider and watcher.
 */
export const kimiAgentPlugin: PluginDefinition = definePlugin({
  name: "Kimi Code",
  description: "Launch Kimi Code from Pragma.",
  watchers: [
    {
      agent: "kimi",
      async watch(ctx) {
        try {
          await baseWatcher.watch(ctx);
        } finally {
          // `SessionEnd` already clears a graceful exit; this covers a session
          // killed hard enough that no hook runs.
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
      id: "kimi",
      name: "Kimi Code",
      icon: () => null,
      iconPath: "assets/kimi.png",
      launch: { command: ["kimi"] },
      prefillDelayMs: PREFILL_DELAY_MS,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: loadKimiModels,
      // First entry is the default: `-y` (yolo), because Kimi's manual mode
      // gates Bash behind a TUI approval prompt, so a plain `kimi` never
      // completes a safe shell command headlessly (`pragma-cli agent verify`
      // `command-no-permission`). These are the real launch flags that change
      // how much Kimi asks for.
      permissionModes: [
        { id: "yolo", name: "Auto-approve tools" },
        { id: "default", name: "Ask for approval" },
        { id: "auto", name: "Fully autonomous" },
        { id: "plan", name: "Plan mode" },
      ],
      modes: modeProvider([{ id: DEFAULT_MODE, name: "Default" }], AGENT_SOURCES),
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES, {
        acp: { command: ["kimi", "acp"] },
      }),
      // `commandApproval`: Kimi's permission-request hook is fire-and-forget,
      // so Pragma cannot approve on the agent's behalf.
      excludeFeatures: ["commandApproval"],
      args: {
        model: (modelId: string) => ["-m", modelId],
        reasoning: () => [],
        mode: (modeId: string) => (modeId === DEFAULT_MODE ? [] : ["--agent", modeId]),
        permissionMode: (permissionModeId: string) => {
          if (permissionModeId === "yolo") {
            return ["-y"];
          }
          if (permissionModeId === "auto") {
            return ["--auto"];
          }
          return permissionModeId === "plan" ? ["--plan"] : [];
        },
      },
    }),
  ],
});

export default kimiAgentPlugin;
