import {
  defineAccounts,
  defineAgent,
  definePlugin,
  slashCommandProvider,
  type AgentModelEntry,
  type AgentSlashCommand,
  type PluginContext,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

import { codexSharedToken } from "./shared-token";
import { identifyCodexAccount, loadCodexUsageLimits } from "./usage-limits";

export { codexAuth, codexSharedToken, parseCodexAuth } from "./shared-token";
export {
  identifyCodexAccount,
  loadCodexUsageLimits,
  parseCodexAccount,
  parseCodexUsageLimits,
} from "./usage-limits";

const INTERJECT_SUBMIT_DELAY_MS = 200;
const PREFILL_SUBMIT_DELAY_MS = 500;
const baseWatcher = createTuiWatcher({
  agent: "codex",
  handleDecisions: false,
  handleQuestionAnswers: true,
  interjectSubmitDelayMs: INTERJECT_SUBMIT_DELAY_MS,
});

/** Built-in commands worth starting a session with; custom prompts are discovered. */
const BUILTIN_SLASH_COMMANDS = [
  { name: "init", description: "Create an AGENTS.md file with instructions for Codex" },
  { name: "review", description: "Review the current changes and find issues" },
  { name: "status", description: "Show session configuration and token usage" },
  { name: "diff", description: "Show the git diff, including untracked files" },
];
/** Codex custom prompts are invoked as `/prompts:<name>`. */
const SLASH_COMMAND_SOURCES = [
  { dir: "~/.codex/prompts", layout: "files" as const, recursive: false, prefix: "prompts:" },
];

/** Pragma plugin for Codex CLI. */
export const codexAgentPlugin: PluginDefinition = definePlugin({
  name: "Codex",
  description: "Launch Codex CLI from Pragma.",
  accounts: defineAccounts([
    {
      provider: "openai",
      agent: "codex",
      dashboardUrl: "https://chatgpt.com/codex/settings/usage",
      iconPath: "assets/codex.png",
      login: {
        command: ["codex", "login"],
        instructions: "Sign in with ChatGPT in the browser tab that opens.",
      },
      // `CODEX_HOME` holds Codex's auth, config, and sessions, so each account
      // gets its own directory.
      env: (home) => ({ CODEX_HOME: home }),
      credentialPath: (home) => `${home ?? "~/.codex"}/auth.json`,
      identify: identifyCodexAccount,
      // Its ChatGPT sign-in can be handed to OpenCode, Pi, and Prime Agent.
      sharedToken: codexSharedToken,
      usageLimits: {
        primaryLimitId: "codex-primary",
        refreshIntervalMs: 60_000,
        load: loadCodexUsageLimits,
      },
    },
  ]),
  watchers: [
    {
      agent: "codex",
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
      id: "codex",
      name: "Codex",
      icon: () => null,
      iconPath: "assets/codex.png",
      launch: { command: ["codex", "--enable", "default_mode_request_user_input"] },
      prefillDelayMs: 4000,
      prefillMode: "plain",
      prefillSubmit: "\r",
      // Codex 0.160 treats a fast burst of keystrokes as a paste and turns an
      // Enter inside it into a newline, so the submit must arrive on its own.
      prefillSubmitDelayMs: PREFILL_SUBMIT_DELAY_MS,
      models: async (ctx) => parseCodexModels(await execFirst(ctx, "codex debug models")),
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES, {
        load: async (ctx) =>
          parseCodexSkills(await execFirst(ctx, "codex debug prompt-input 2>/dev/null")),
      }),
      // First entry is the default: no flag, so Codex's own config decides.
      permissionModes: [
        { id: "default", name: "Use Codex config" },
        { id: "untrusted", name: "Ask for untrusted commands" },
        { id: "on-request", name: "Ask when requested" },
        { id: "never", name: "Never ask" },
      ],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => [
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningId)}`,
        ],
        modelReasoning: (modelId: string, reasoningId: string) => [
          "--model",
          modelId,
          "--config",
          `model_reasoning_effort=${JSON.stringify(reasoningId)}`,
        ],
        permissionMode: (permissionModeId: string) =>
          permissionModeId === "default" ? [] : ["--ask-for-approval", permissionModeId],
      },
    }),
  ],
});

export default codexAgentPlugin;

/**
 * Reads the skills Codex itself resolved — every root it scans, plugin caches
 * included — from the "Available skills" section of `codex debug prompt-input`.
 * Codex invokes a skill as `$name`, so each carries that invocation.
 */
export function parseCodexSkills(output: string): AgentSlashCommand[] {
  const text = promptText(output);
  const start = text.indexOf("### Available skills");
  if (start === -1) return [];
  const skills: AgentSlashCommand[] = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (line.startsWith("#")) break;
    const match = /^- ([\w.:-]+): (.*?)(?: \(file: [^)]*\))?$/.exec(line.trim());
    if (!match) continue;
    const [, name, description] = match;
    skills.push({ name: name!, description: description!, invocation: `$${name}` });
  }
  return skills;
}

/** Every string in the prompt-input JSON, joined; raw output when it is not JSON. */
function promptText(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  const texts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(parsed);
  return texts.join("\n");
}

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [command],
  });
  return result?.stdout ?? "";
}

/** Parses `codex debug models` output into visible launcher entries. */
export function parseCodexModels(output: string): AgentModelEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  const models: AgentModelEntry[] = [];
  for (const candidate of value.models) {
    if (!isRecord(candidate) || candidate.visibility !== "list") {
      continue;
    }
    const id = stringValue(candidate.slug);
    const name = stringValue(candidate.display_name);
    if (!id || !name || id === "auto") {
      continue;
    }
    const reasoning = Array.isArray(candidate.supported_reasoning_levels)
      ? candidate.supported_reasoning_levels.flatMap((level) => reasoningEntry(level))
      : [];
    models.push(reasoning.length > 0 ? { id, name, reasoning } : { id, name });
  }
  return models;
}

function reasoningEntry(value: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(value)) {
    return [];
  }
  const id = stringValue(value.effort);
  if (!id) {
    return [];
  }
  return [{ id, name: id === "xhigh" ? "Extra High" : titleCase(id) }];
}

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
