import {
  defineAccounts,
  defineAgent,
  definePlugin,
  type AccountIdentity,
  modeProvider,
  slashCommandProvider,
  type AgentMode,
  type PluginContext,
  type PluginDefinition,
  type UsageLimit,
  type UsageLimitsResult,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

/** Lets Claude Code's paste-aware TUI commit interjected text before Enter. */
const INTERJECT_SUBMIT_DELAY_MS = 200;
const USAGE_REQUEST = JSON.stringify({
  type: "control_request",
  request_id: "pragma-usage",
  request: { subtype: "get_usage" },
});
const USAGE_COMMAND = `printf '%s\\n' '${USAGE_REQUEST}' | claude -p --safe-mode --input-format stream-json --output-format stream-json --verbose`;

const reasoningFull = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];
const reasoningStandard = reasoningFull.slice(0, 3);

/** Built-in commands worth starting a session with; project/user commands are discovered. */
const BUILTIN_SLASH_COMMANDS = [
  { name: "init", description: "Initialize a CLAUDE.md with codebase documentation" },
  { name: "review", description: "Review a pull request", argumentHint: "[pr]" },
  { name: "security-review", description: "Security review of the pending changes" },
];
/** Project first so a project command shadows a user one with the same name. */
const SLASH_COMMAND_SOURCES = [
  { dir: ".claude/commands", layout: "files" as const },
  { dir: ".claude/skills", layout: "skills" as const },
  { dir: "~/.claude/commands", layout: "files" as const },
  { dir: "~/.claude/skills", layout: "skills" as const },
];
const AGENT_SOURCES = [
  { dir: ".claude/agents", layout: "files" as const, nameFromFrontmatter: true },
  { dir: "~/.claude/agents", layout: "files" as const, nameFromFrontmatter: true },
];
/** Claude Code's own name for the default session agent (no `--agent` flag). */
const DEFAULT_MODE = "claude";
/** Built-in agents that are utilities, not a way to run a session. */
const HIDDEN_AGENTS = new Set(["statusline-setup"]);
/**
 * `--agent` with an unknown name makes Claude Code print every agent it can
 * start — built-in, user, project, and plugin — and exit before any model
 * call, which makes it the authoritative (and cheap) agent list.
 */
const AGENT_PROBE = "claude -p --agent __pragma_list_agents__ ok 2>&1";

/**
 * Pragma plugin for Claude Code, bundled to `dist/pragma-plugin.mjs` and loaded
 * by the pragma-plugins sidecar, the desktop webview, and the `pragma-watch`
 * sidecar alike. Approvals go through Claude Code's blocking `await-decision`
 * hook, so the watcher only delivers interjections (`handleDecisions: false`).
 */
export const claudeCodeAgentPlugin: PluginDefinition = definePlugin({
  name: "Claude Code",
  description: "Launch Claude Code from Pragma.",
  accounts: defineAccounts([
    {
      provider: "anthropic",
      agent: "claude-code",
      dashboardUrl: "https://claude.ai/new#settings/usage",
      iconPath: "assets/claude-code.svg",
      login: {
        command: ["claude", "auth", "login"],
        instructions: "Finish signing in to Claude in the browser tab that opens.",
      },
      // Claude Code keeps every credential and setting under its config dir, so
      // pointing it at a Pragma-owned one gives each account its own login.
      env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
      credentialPath: claudeCredentialPath,
      identify: identifyClaudeAccount,
      usageLimits: {
        primaryLimitId: "five-hour",
        // Each refresh spawns a headless `claude -p` session that queries
        // Anthropic's strictly rate-limited OAuth usage endpoint; polling
        // faster causes 429s.
        refreshIntervalMs: 300_000,
        load: loadClaudeUsageLimits,
      },
    },
  ]),
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
      launch: { command: ["claude"] },
      // `claude --model` takes aliases that always resolve to the newest model in
      // the family; `canonicalId` names that model so auto mode can find its
      // benchmarks. Update it when an alias moves to a new release.
      models: [
        {
          id: "sonnet",
          name: "Sonnet",
          canonicalId: "anthropic/claude-sonnet-5-5",
          reasoning: reasoningFull,
        },
        {
          id: "opus",
          name: "Opus",
          canonicalId: "anthropic/claude-opus-5-5",
          reasoning: reasoningStandard,
        },
        {
          id: "fable",
          name: "Fable",
          canonicalId: "anthropic/claude-fable-5-1",
          reasoning: reasoningFull,
        },
        {
          id: "haiku",
          name: "Haiku",
          canonicalId: "anthropic/claude-haiku-4-5",
          reasoning: reasoningStandard,
        },
      ],
      // First entry is the default: `auto` keeps unattended launches moving.
      permissionModes: [
        { id: "auto", name: "Auto", description: "Classifier approves safe actions" },
        { id: "manual", name: "Ask before actions" },
        { id: "acceptEdits", name: "Accept edits" },
        { id: "plan", name: "Plan mode", description: "Read-only planning" },
        { id: "dontAsk", name: "Don't ask", description: "Deny anything not pre-approved" },
        { id: "bypassPermissions", name: "Bypass permissions" },
      ],
      // `--agent` starts the session as one of the user's or project's agents.
      modes: loadClaudeAgents,
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES),
      // `--permission-mode auto` (the default) auto-approves every shell command, so a
      // command-approval attention can never be raised for a launched
      // session (`pragma-cli agent verify` `command-allow`/`command-deny`):
      // the model runs the tool and the turn settles. The blocking
      // `PermissionRequest` hook still round-trips `AskUserQuestion`
      // (`questions` stays enabled), but approvals are only exercisable when
      // a permission prompt actually fires, which the auto launch prevents.
      excludeFeatures: ["commandApproval"],
      args: {
        model: (modelId: string) => ["--model", modelId],
        reasoning: (reasoningId: string) => ["--effort", reasoningId],
        permissionMode: (permissionModeId: string) => ["--permission-mode", permissionModeId],
        mode: (modeId: string) => (modeId === DEFAULT_MODE ? [] : ["--agent", modeId]),
      },
    }),
  ],
});

export default claudeCodeAgentPlugin;

/** Where Claude Code keeps a login's token: the macOS Keychain, else the config dir. */
export function claudeCredentialPath(home: string | null): string {
  if (globalThis.process?.platform === "darwin") return "macOS Keychain (Claude Code-credentials)";
  return `${home ?? "~/.claude"}/.credentials.json`;
}

/** Reports the signed-in Claude account from `claude auth status --json`. */
export async function identifyClaudeAccount(ctx: PluginContext): Promise<AccountIdentity | null> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: ["claude auth status --json"] });
  if (!result || result.status !== 0) {
    return null;
  }
  return parseClaudeAuthStatus(result.stdout);
}

/** Parses `claude auth status --json`; a signed-out config dir yields null. */
export function parseClaudeAuthStatus(stdout: string): AccountIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.loggedIn !== true) {
    return null;
  }
  const email = typeof value.email === "string" ? value.email : undefined;
  const orgId = typeof value.orgId === "string" ? value.orgId : undefined;
  const id = orgId && email ? `${orgId}:${email}` : (orgId ?? email);
  if (!id) {
    return null;
  }
  const plan = typeof value.subscriptionType === "string" ? value.subscriptionType : undefined;
  return {
    id,
    ...(email ? { email } : {}),
    ...(typeof value.orgName === "string" ? { name: value.orgName } : {}),
    ...(plan ? { plan: plan.charAt(0).toUpperCase() + plan.slice(1) } : {}),
  };
}

/** Lists the agents `--agent` accepts, falling back to agent files on disk. */
export async function loadClaudeAgents(ctx: PluginContext): Promise<AgentMode[]> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec
    .run({ cwd, commands: [AGENT_PROBE] })
    .catch(() => [undefined]);
  const agents = parseClaudeAgents(result?.stdout ?? "");
  if (agents.length > 0) return agents;
  return modeProvider([{ id: DEFAULT_MODE, name: "Default" }], AGENT_SOURCES)(ctx);
}

/**
 * Parses the `Available agents: a, b, c` line Claude Code prints for an unknown
 * `--agent`. The default agent comes first as "Default"; utility agents are dropped.
 */
export function parseClaudeAgents(output: string): AgentMode[] {
  const list = /Available agents:\s*(.+)/.exec(output)?.[1];
  if (!list) return [];
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id && !HIDDEN_AGENTS.has(id) && id !== DEFAULT_MODE);
  return [{ id: DEFAULT_MODE, name: "Default" }, ...ids.map((id) => ({ id, name: agentName(id) }))];
}

function agentName(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Loads plan usage through Claude Code's structured `/usage` control request. */
export async function loadClaudeUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  const cwd = ctx.project?.path ?? "/tmp";
  const [result] = await ctx.sdk.exec.run({ cwd, commands: [USAGE_COMMAND] });
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "Claude Code usage request failed");
  }
  return extractUsageFromOutput(result.stdout);
}

/** Scans NDJSON control-response output for the usage reply and normalizes it. */
function extractUsageFromOutput(stdout: string): UsageLimitsResult {
  for (const line of stdout.split("\n")) {
    const response = tryParseUsageControlResponse(line);
    if (response === undefined) {
      continue;
    }
    if (response.subtype === "error") {
      throw new Error(response.error || "Claude Code usage request failed");
    }
    return parseClaudeUsage(response.response, Date.now());
  }
  throw new Error("Claude Code did not return usage data");
}

/** Parses one NDJSON line as a usage control response, ignoring non-matching or malformed lines. */
function tryParseUsageControlResponse(
  line: string,
): { subtype: "success"; response: unknown } | { subtype: "error"; error?: string } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isUsageControlResponse(value) ? value.response : undefined;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return undefined;
    }
    throw cause;
  }
}

/** Normalizes Claude Code's structured `/usage` response into generic usage limits. */
export function parseClaudeUsage(value: unknown, observedAt: number): UsageLimitsResult {
  if (!isRecord(value)) {
    throw new Error("Claude Code usage response was not an object");
  }
  if (value.rate_limits_available !== true) {
    return {
      status: "unavailable",
      reason: "authentication-required",
      message: "Sign in to Claude Code with a subscription to load usage limits.",
    };
  }
  if (!isRecord(value.rate_limits)) {
    // Signed in, but the CLI's usage fetch returned no data — usually a transient
    // 429 from the usage endpoint. Throwing (instead of returning "unavailable")
    // keeps the host's last snapshot and triggers its retry backoff.
    throw new Error("Claude Code usage data is temporarily unavailable (rate limited)");
  }

  const rateLimits = value.rate_limits;
  const limits: UsageLimit[] = [];
  addWindow(limits, "five-hour", "5-hour limit", rateLimits.five_hour, observedAt);
  addWindow(limits, "seven-day", "Weekly limit", rateLimits.seven_day, observedAt);
  addWindow(
    limits,
    "seven-day-oauth-apps",
    "Weekly OAuth apps",
    rateLimits.seven_day_oauth_apps,
    observedAt,
  );
  addWindow(limits, "seven-day-opus", "Weekly Opus", rateLimits.seven_day_opus, observedAt);
  addWindow(limits, "seven-day-sonnet", "Weekly Sonnet", rateLimits.seven_day_sonnet, observedAt);

  if (Array.isArray(rateLimits.model_scoped)) {
    for (const [index, scoped] of rateLimits.model_scoped.entries()) {
      if (!isRecord(scoped) || typeof scoped.display_name !== "string") {
        continue;
      }
      addWindow(
        limits,
        `model-${index}`,
        scoped.display_name,
        { utilization: scoped.utilization, resets_at: scoped.resets_at },
        observedAt,
      );
    }
  }

  if (!limits.some((limit) => limit.id === "five-hour")) {
    return {
      status: "unavailable",
      reason: "unsupported",
      message: "Claude Code did not return its 5-hour usage limit.",
    };
  }
  return { status: "ready", observedAt, limits };
}

function addWindow(
  limits: UsageLimit[],
  id: string,
  title: string,
  value: unknown,
  observedAt: number,
): void {
  if (!isRecord(value) || !isFiniteNumber(value.utilization)) {
    return;
  }
  const resetAt = parseDate(value.resets_at);
  limits.push({
    id,
    title,
    used: Math.min(100, Math.max(0, value.utilization)),
    limit: 100,
    ...(resetAt === null ? {} : { resetsInMs: Math.max(0, resetAt - observedAt) }),
  });
}

function parseDate(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUsageControlResponse(value: unknown): value is {
  type: "control_response";
  response: { subtype: "success"; response: unknown } | { subtype: "error"; error?: string };
} {
  if (!isRecord(value) || value.type !== "control_response" || !isRecord(value.response)) {
    return false;
  }
  return (
    (value.response.subtype === "success" && "response" in value.response) ||
    value.response.subtype === "error"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
