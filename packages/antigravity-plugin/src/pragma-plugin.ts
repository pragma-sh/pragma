import {
  agentLaunchArgs,
  defineAccounts,
  defineAgent,
  definePlugin,
  modelFlagArgs,
  slashCommandProvider,
  type AgentArgsBuilder,
  type AgentModelEntry,
  type AgentPermissionMode,
  type AgentResumeRequest,
  type PluginContext,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import type { WatcherContext } from "@pragma-sh/plugin";
import { createTuiWatcher, type TuiWatcherConfig } from "@pragma-sh/watcher-kit";

import { ScreenScanner, type ScreenEvent } from "./screen";
import { loadAntigravityUsageLimits, PRIMARY_LIMIT_ID } from "./usage-limits";

export { loadAntigravityUsageLimits, parseAntigravityUsage } from "./usage-limits";

/** The `defineAgent` id; `hooks` report under exactly this id (see `src/hook/handle.ts`). */
const AGENT_ID = "antigravity";
/** agy signs in and paints its composer within a few seconds of launch. */
const PREFILL_DELAY_MS = 4000;
/** Each refresh spawns a short-lived `agy -p /usage`; don't poll it hard. */
const USAGE_REFRESH_INTERVAL_MS = 300_000;
/** Lets the approval prompt mount before answer keys arrive. */
const PROMPT_KEY_DELAY_MS = 150;

/**
 * Keys that answer agy's approval prompt. Digit `1` selects-and-submits
 * "Yes, run command"; "No, cancel" is always the last row, and Up from the
 * first row wraps onto it, whatever number of "always allow" rows sit between.
 */
const APPROVAL_KEYS: TuiWatcherConfig = { approveKeys: "1", denyKeys: "\x1b[A\r" };

const baseWatcher = createTuiWatcher({
  agent: AGENT_ID,
  // agy has no decision-returning approval hook: PreToolUse runs before the
  // permission check and cannot know whether a prompt follows. The prompt is
  // detected on screen (below) and answered with keys.
  handleDecisions: true,
  // `ask_question` digits select-and-advance, "Write-in..." is the row after
  // the last option (Down + Enter opens it), and Esc skips: the defaults.
  handleQuestionAnswers: true,
});

/** Session-only settings that make agy ask before every shell command. */
const ASK_COMMANDS_SETTINGS = JSON.stringify({ permissions: { ask: ["command(*)"] } });

/**
 * Permission modes. The first, `default`, passes nothing so agy's own agent
 * mode applies (Auto unless the user changed it in `/config`). `ask` layers a
 * session-only `ask` rule over the user's settings with `--settings`, which
 * agy never saves.
 */
const PERMISSION_MODES: AgentPermissionMode[] = [
  { id: "default", name: "Use Antigravity config" },
  { id: "ask", name: "Ask before commands" },
  { id: "accept-edits", name: "Accept edits" },
  { id: "plan", name: "Plan mode" },
  { id: "skip", name: "Skip permissions" },
];

/** Launch flags for a model/reasoning/permission selection. */
export const antigravityArgs: AgentArgsBuilder = {
  permissionMode: permissionModeArgs,
  model: modelFlagArgs,
  // Unused by the flat model list (the effort is in the model id) but accepted
  // by `agy --effort` should a model ever list separate efforts.
  reasoning: (reasoningId: string) => ["--effort", reasoningId],
};

function permissionModeArgs(permissionModeId: string): string[] {
  switch (permissionModeId) {
    case "ask":
      return ["--settings", ASK_COMMANDS_SETTINGS];
    case "accept-edits":
    case "plan":
      return ["--mode", permissionModeId];
    case "skip":
      return ["--dangerously-skip-permissions"];
    default:
      return [];
  }
}

/**
 * Builds the full literal argv for resuming a recorded conversation: the base
 * command, the stored model/permission flags, and `--conversation <id>`
 * ("Resume a previous conversation by ID" in `agy --help`). The id is the
 * `conversationId` every hook payload carries, reported as the harness session.
 */
export function antigravityResume(request: AgentResumeRequest, _ctx: PluginContext): string[] {
  const selected = agentLaunchArgs(LAUNCH_OPTIONS, request.selection);
  return ["agy", ...selected, "--conversation", request.harnessSessionId];
}

/** What `agentLaunchArgs` needs to rebuild a launch's flags. */
const LAUNCH_OPTIONS = { args: antigravityArgs, permissionModes: PERMISSION_MODES };

/** agy built-ins worth starting a session with (`agy -p /help`); skills are discovered. */
const BUILTIN_SLASH_COMMANDS = [
  { name: "usage", description: "View model quota usage" },
  { name: "model", description: "Set a model, or run a single prompt on another model" },
  { name: "effort", description: "Set the reasoning effort" },
  { name: "agents", description: "List available custom agents" },
  { name: "skills", description: "List available skills" },
  { name: "permissions", description: "Manage tool permissions" },
];
/** Workspace and global skill roots; agy expands a skill as `/<name>`. */
const SLASH_COMMAND_SOURCES = [
  { dir: ".agents/skills", layout: "skills" as const },
  { dir: "~/.gemini/config/skills", layout: "skills" as const },
];

/**
 * Pragma plugin for the Google Antigravity CLI (`agy`), bundled to
 * `dist/pragma-plugin.mjs`.
 *
 * Lifecycle reporting is a native Antigravity plugin (`agy-plugin/`: a
 * `hooks.json` whose handlers run `dist/hook.mjs`), installed with agy's own
 * `agy plugin install` by `scripts/install-local.ts`. This module contributes
 * the launcher, model list, usage limits, and the watcher that handles what
 * only the TUI shows: approval prompts, interrupts, and the trust gate.
 */
export const antigravityAgentPlugin: PluginDefinition = definePlugin({
  name: "Antigravity",
  description: "Launch the Google Antigravity CLI from Pragma.",
  accounts: defineAccounts([
    {
      provider: "google-antigravity",
      title: "Google Antigravity",
      agent: AGENT_ID,
      dashboardUrl: "https://antigravity.google",
      iconPath: "assets/antigravity.svg",
      // agy signs in from its own first-run screen and has no config-dir
      // override, so it has exactly one login: the one the harness owns.
      usageLimits: {
        primaryLimitId: PRIMARY_LIMIT_ID,
        refreshIntervalMs: USAGE_REFRESH_INTERVAL_MS,
        load: loadAntigravityUsageLimits,
      },
    },
  ]),
  watchers: [
    {
      agent: AGENT_ID,
      async watch(ctx) {
        const keyed = {
          ...ctx,
          config: { ...APPROVAL_KEYS, ...(ctx.config as TuiWatcherConfig | undefined) },
        };
        try {
          await Promise.all([baseWatcher.watch(keyed), watchScreen(ctx)]);
        } finally {
          // agy has no session-end hook; this clears every exit, graceful or not.
          await report(ctx, { status: "cleared", attentionKind: null });
        }
      },
    },
  ],
  agents: [
    defineAgent({
      id: AGENT_ID,
      name: "Antigravity",
      icon: () => null,
      iconPath: "assets/antigravity.svg",
      launch: { command: ["agy"], resume: antigravityResume },
      prefillDelayMs: PREFILL_DELAY_MS,
      prefillMode: "plain",
      prefillSubmit: "\r",
      models: loadAntigravityModels,
      permissionModes: PERMISSION_MODES,
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES),
      args: antigravityArgs,
    }),
  ],
});

export default antigravityAgentPlugin;

/** Reads the launcher's model list from `agy models` (`<id>\t<name>` lines). */
export async function loadAntigravityModels(ctx: PluginContext): Promise<AgentModelEntry[]> {
  try {
    const [result] = await ctx.sdk.exec.run({
      cwd: ctx.project?.path ?? "/tmp",
      commands: ["agy models"],
    });
    return result?.status === 0 ? parseAntigravityModels(result.stdout) : [];
  } catch {
    // The launcher must still open when agy cannot be queried (offline, not
    // signed in); agy then starts on its own configured default model.
    return [];
  }
}

/**
 * Parses `agy models`. Reasoning effort is part of the model id
 * (`gemini-3.8-flash-high`), so the list is flat.
 */
export function parseAntigravityModels(stdout: string): AgentModelEntry[] {
  const models: AgentModelEntry[] = [];
  for (const line of stdout.split("\n")) {
    const [id, name] = line.split("\t").map((part) => part.trim());
    if (!id || !name || /\s/.test(id)) continue;
    models.push({ id, name });
  }
  return models;
}

/** Turns what agy shows only on screen into reports and keys. */
async function watchScreen(ctx: WatcherContext<unknown>): Promise<void> {
  const scanner = new ScreenScanner();
  let sequence = 0;
  try {
    for await (const chunk of ctx.output) {
      for (const event of scanner.push(chunk)) {
        sequence += 1;
        // oxlint-disable-next-line no-await-in-loop -- reports must keep the TUI's order.
        await applyScreenEvent(
          ctx,
          event,
          `${AGENT_ID}-${ctx.session.tabId}-screen-${sequence}-${Date.now()}`,
        );
      }
    }
  } catch {
    // The output stream can drop independently of the session; the finally
    // in `watch` still clears on exit.
  }
}

async function applyScreenEvent(
  ctx: WatcherContext<unknown>,
  event: ScreenEvent,
  requestId: string,
): Promise<void> {
  switch (event.type) {
    case "approval":
      await report(ctx, {
        status: "attention",
        attentionKind: "command",
        command: event.command,
        requestId,
      });
      return;
    case "interrupted":
      // An Esc interrupt or a declined approval ends the turn without any hook.
      await report(ctx, { status: "cleared", attentionKind: null });
      return;
    case "trust":
      // The folder was opened from Pragma on purpose; accept agy's
      // first-launch trust gate (default row) so the prefilled prompt lands in
      // the composer instead of being swallowed by the dialog.
      await delay(PROMPT_KEY_DELAY_MS);
      await sendKeys(ctx, "\r");
      return;
    default:
      return;
  }
}

async function report(
  ctx: WatcherContext<unknown>,
  fields: {
    status: "attention" | "cleared";
    attentionKind: "command" | null;
    command?: string;
    requestId?: string;
  },
): Promise<void> {
  try {
    await ctx.sdk.agents.report({
      agent: ctx.agentId,
      tabId: ctx.session.tabId,
      worktreeId: ctx.session.worktreeId,
      ...fields,
    });
  } catch {
    // Reporting must never stop the watcher.
  }
}

async function sendKeys(ctx: WatcherContext<unknown>, keys: string): Promise<void> {
  try {
    await ctx.sendKeys(keys);
  } catch {
    // A transient write failure must not stop output monitoring.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
