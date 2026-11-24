import {
  accountProviderTitle,
  agentLaunchArgs,
  defineAccounts,
  defineAgent,
  definePlugin,
  modelsDevAccountProviders,
  type AccountProviderDefinition,
  commandAndSkillDirs,
  slashCommandProvider,
  type AgentArgsBuilder,
  type AgentMode,
  type AgentModelEntry,
  type CredentialStore,
  type ModelsDevAccountProvider,
  type PluginContext,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

import { openCodeStoreAccount } from "./accounts";
import { pluginCwd, type HostContext } from "./cwd";
import { openCodeApi } from "./opencode-api";
import {
  openCodeV2ModelEntries,
  readOpenCodeV2Agents,
  readOpenCodeV2Models,
  readOpenCodeV2Providers,
} from "./opencode-v2-catalog";
import { isOpenCodeV2, openCodeTakesSelectionFlags } from "./opencode-version";
import {
  createOutputFeed,
  planIsEmpty,
  planSelection,
  runSelectionPlan,
  type SelectionPlan,
} from "./tui-selection";
import { loadOpenCodeGoUsageLimits } from "./usage-limits";

/**
 * OpenCode v1 keeps every provider's credential in one `auth.json` under
 * `$XDG_DATA_HOME/opencode`, keyed by provider id. OpenCode v2 keeps them in
 * its database instead (see `./accounts.ts`).
 */
const OPENCODE_STORE: CredentialStore = {
  dirEnv: "XDG_DATA_HOME",
  defaultDir: "~/.local/share",
  file: "opencode/auth.json",
};

/**
 * The one sign-in command both OpenCode versions accept: v1 preselects a
 * provider with `--provider`, v2 with a positional target, and each rejects
 * the other's form. Bare, both open a provider picker. Pragma types this into
 * the user's shell, so a version check there would not be portable.
 */
const OPENCODE_LOGIN = ["opencode", "auth", "login"];

/**
 * API-key providers OpenCode signs in to, named by their models.dev ids in
 * `auth.json`; `opencode auth login` preselects the first. OpenAI and OpenCode
 * Go are declared above with their own logins.
 *
 * Every entry is a key the provider sells for use in any client. Anthropic is
 * key-only on purpose: Claude Free/Pro/Max OAuth may only be used in Claude
 * Code and claude.ai. Google is the Gemini API key; Gemini CLI and Antigravity
 * OAuth are not offered, since Google suspends accounts that use them here.
 */
export const OPENCODE_API_KEY_PROVIDERS: ModelsDevAccountProvider[] = modelsDevAccountProviders([
  "openai",
  "opencode-go",
]);

function openCodeApiKeyProvider({
  provider,
  modelsDevIds,
}: ModelsDevAccountProvider): AccountProviderDefinition {
  const title = accountProviderTitle(provider);
  return openCodeStoreAccount({
    provider,
    agent: "opencode",
    store: OPENCODE_STORE,
    entries: modelsDevIds,
    apiKeyOnly: true,
    login: {
      command: OPENCODE_LOGIN,
      instructions: `Pick ${title} when asked (type to filter, then send), then paste your ${title} API key.`,
    },
  });
}

/** OpenCode's own GitHub OAuth app (its GitHub Copilot sign-in). */
const OPENCODE_GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz";

const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** OpenCode's own primary agents, used when `opencode agent list` is unavailable. */
const DEFAULT_MODES: AgentMode[] = [
  { id: "build", name: "Build" },
  { id: "plan", name: "Plan" },
];
/** Primary agents OpenCode runs internally and never offers in its Tab cycle. */
const HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);
const BUILTIN_SLASH_COMMANDS = [
  { name: "init", description: "Create or update AGENTS.md" },
  { name: "review", description: "Review changes", argumentHint: "[commit|branch|pr]" },
];
/** Fallback when the ACP list is unavailable (OpenCode also accepts singular `command`). */
const SLASH_COMMAND_SOURCES = [
  ...commandAndSkillDirs([".opencode", "~/.config/opencode"]),
  { dir: ".opencode/command", layout: "files" as const },
  { dir: "~/.config/opencode/command", layout: "files" as const },
];

/**
 * The option builders a launch and a resume share, so a resumed session is
 * flagged exactly like the launch it continues. `--session`, `--model`, and
 * `--agent` are all top-level options on v1 (verified against `opencode
 * --help`, 1.18.35); OpenCode has no permission-mode flag.
 *
 * v2 kept only `--session` (verified against 2.1.1): its TUI rejects the other
 * two with `Unrecognized flag` and exits, and neither a config environment
 * variable nor the TUI plugin API can set the model instead. So on v2 a
 * selection adds no argument; the watcher applies it by driving OpenCode's
 * own pickers ({@link applyLaunchSelection}).
 */
/**
 * The model list when OpenCode v2's API cannot be read: whatever OpenCode
 * itself has selected. It is one entry rather than none because an agent with
 * no models reads everywhere as a broken catalog ("No models found", the
 * verify catalog gate, the last-good fallback), which would hide a working
 * agent. The watcher finds no such model and leaves OpenCode's choice alone.
 */
const OPENCODE_V2_FALLBACK_MODELS: AgentModelEntry[] = [
  { id: "default", name: "OpenCode default" },
];

/** OpenCode v2's models, with names and reasoning variants, from its server API. */
async function openCodeV2Models(ctx: HostContext): Promise<AgentModelEntry[]> {
  try {
    const entries = openCodeV2ModelEntries(
      readOpenCodeV2Models(await openCodeApi(ctx, "GET", "/api/model")),
    );
    return entries.length > 0 ? entries : OPENCODE_V2_FALLBACK_MODELS;
  } catch {
    return OPENCODE_V2_FALLBACK_MODELS;
  }
}

/** OpenCode v2's selectable agents, falling back to its two built-ins. */
async function openCodeV2Modes(ctx: HostContext): Promise<AgentMode[]> {
  try {
    const modes = readOpenCodeV2Agents(await openCodeApi(ctx, "GET", "/api/agent"));
    return modes.length > 0 ? modes : DEFAULT_MODES;
  } catch {
    return DEFAULT_MODES;
  }
}

const OPENCODE_AGENT_ARGS: AgentArgsBuilder = {
  model: (modelId: string) => (openCodeTakesSelectionFlags() ? ["--model", modelId] : []),
  reasoning: () => [],
  permissionMode: () => [],
  mode: (modeId: string) => (openCodeTakesSelectionFlags() ? ["--agent", modeId] : []),
};

/**
 * Pragma plugin for OpenCode, bundled to `dist/pragma-plugin.mjs` and loaded by
 * the pragma-plugins sidecar, the desktop webview, and the `pragma-watch`
 * sidecar alike. OpenCode exposes no decision-returning plugin hook on the
 * current binary, so remote command approvals and question answers go the
 * watcher route (`handleDecisions: true`).
 */
const baseWatcher = createTuiWatcher({
  agent: "opencode",
  handleDecisions: true,
  questionFinalizeKeys: "\r",
});

type OpenCodeWatchContext = Parameters<typeof baseWatcher.watch>[0];

/**
 * Builds the picker inputs for this launch, or `null` when there is nothing to
 * drive: no selection, OpenCode v1 (which took the selection as flags), or
 * lists that could not be read.
 */
async function launchSelectionPlan(ctx: OpenCodeWatchContext): Promise<SelectionPlan | null> {
  const { selection } = ctx;
  if (!selection?.modelId && !selection?.modeId) return null;
  const host: HostContext = { sdk: ctx.sdk };
  try {
    if (!(await isOpenCodeV2(host))) return null;
    const [models, providers] = selection.modelId
      ? await Promise.all([
          openCodeApi(host, "GET", "/api/model"),
          openCodeApi(host, "GET", "/api/provider"),
        ])
      : [null, null];
    const plan = planSelection(
      selection,
      readOpenCodeV2Models(models),
      readOpenCodeV2Providers(providers),
    );
    return planIsEmpty(plan) ? null : plan;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Applies the launch's model, variant, and agent to OpenCode v2 through its
 * TUI. See `tui-selection.ts`. Never throws: a selection that cannot be
 * applied leaves OpenCode on its own choice, and the watcher's other duties
 * (answers, approvals, interrupts) must go on.
 */
async function applyLaunchSelection(ctx: OpenCodeWatchContext): Promise<void> {
  const feed = createOutputFeed();
  let reading = true;
  // Read from the first byte: the start screen can be drawn before the lists
  // below have been fetched.
  const pump = (async () => {
    for await (const chunk of ctx.output) {
      if (!reading) return;
      feed.push(chunk);
    }
  })().catch(() => {
    // The output transport reconnects on its own; the base watcher owns the session.
  });
  try {
    const plan = await launchSelectionPlan(ctx);
    if (!plan) return;
    const outcome = await runSelectionPlan(
      { feed, sendKeys: ctx.sendKeys, sleep, now: Date.now },
      plan,
    );
    process.stderr.write(
      `${JSON.stringify({ type: "watcher.opencodeSelection", sessionId: ctx.session.id, ...outcome })}\n`,
    );
  } catch {
    // A failed write leaves OpenCode on its own selection.
  } finally {
    reading = false;
    void pump;
  }
}

export const opencodeAgentPlugin: PluginDefinition = definePlugin({
  name: "OpenCode",
  description: "Launch OpenCode from Pragma.",
  watchers: [
    {
      ...baseWatcher,
      async watch(ctx) {
        await Promise.all([baseWatcher.watch(ctx), applyLaunchSelection(ctx)]);
      },
    },
  ],
  accounts: defineAccounts([
    {
      // OpenCode Go switches like every other OpenCode provider (see below). A
      // per-login `XDG_DATA_HOME` used to separate its accounts, but OpenCode
      // v2 serves every process from one background service and database, so
      // a data directory no longer selects an account. Logins made that way
      // already keep their key at `<home>/opencode/auth.json`, which is where
      // the swap reads a login's saved entries.
      ...openCodeStoreAccount({
        provider: "opencode-go",
        agent: "opencode",
        store: OPENCODE_STORE,
        entries: ["opencode-go"],
        // The key is shared with Pi, Prime Agent, and Kimi Code holding OpenCode Go.
        login: {
          command: OPENCODE_LOGIN,
          instructions:
            "Pick OpenCode Go when asked (type to filter, then send), then paste the key from opencode.ai/auth.",
        },
      }),
      dashboardUrl: "https://opencode.ai/auth",
      iconPath: "assets/opencode.svg",
      usageLimits: {
        primaryLimitId: "rolling",
        load: loadOpenCodeGoUsageLimits,
      },
    },
    // Every OpenCode provider shares one credential store, so none can take a
    // data directory of its own. They switch accounts at launch instead —
    // swapping entries in v1's `auth.json`, activating the bound credential on
    // v2 (`openCodeStoreAccount`): a new account signs in inside its own Pragma home, and merges with the
    // Codex and Copilot CLI accounts it belongs to. Their usage comes from
    // those harnesses, and so does the row's icon: no `iconPath`, or
    // OpenCode's logo could head the OpenAI row.
    {
      ...openCodeStoreAccount({
        provider: "openai",
        agent: "opencode",
        store: OPENCODE_STORE,
        entries: ["openai"],
        switchable: true,
        // Same OAuth client as Codex: a ChatGPT account signed in through
        // Codex (or Pi) can be used here without signing in again.
        sharedToken: { kind: "chatgpt", entry: "openai", type: "oauth" },
        login: {
          command: OPENCODE_LOGIN,
          instructions:
            "Pick OpenAI, then ChatGPT Pro/Plus (browser), and sign in in the browser tab that opens.",
        },
      }),
      dashboardUrl: "https://chatgpt.com/codex/settings/usage",
    },
    {
      ...openCodeStoreAccount({
        provider: "github-copilot",
        agent: "opencode",
        store: OPENCODE_STORE,
        entries: ["github-copilot"],
        switchable: true,
        // OpenCode signs in through its own GitHub OAuth app, so its Copilot
        // sign-in is only exchanged with harnesses that use the same app.
        sharedToken: {
          kind: `github-copilot:${OPENCODE_GITHUB_CLIENT_ID}`,
          entry: "github-copilot",
          type: "oauth",
        },
        login: {
          command: OPENCODE_LOGIN,
          instructions:
            "Pick GitHub Copilot and GitHub.com, then enter the code shown here on the GitHub page that opens.",
        },
      }),
      dashboardUrl: "https://github.com/settings/copilot",
    },
    // Keys for every other provider share the same `auth.json`, so they follow
    // OpenCode's own sign-in too.
    ...OPENCODE_API_KEY_PROVIDERS.map(openCodeApiKeyProvider),
  ]),
  agents: [
    defineAgent({
      id: "opencode",
      name: "OpenCode",
      icon: () => null,
      iconPath: "assets/opencode.svg",
      launch: {
        command: ["opencode"],
        // `opencode --session <id>` continues that exact stored session, which
        // keeps its own agent and model, so a resume replays only an explicit
        // selection — never the original slash command or prompt.
        resume: async ({ harnessSessionId, selection }, ctx) => {
          // The argument builders read the probed version; a resume can be the
          // first thing this process does, so probe before building.
          await isOpenCodeV2(ctx);
          return [
            "opencode",
            "--session",
            harnessSessionId,
            ...agentLaunchArgs(
              { args: OPENCODE_AGENT_ARGS, modes: [], permissionModes: [] },
              selection,
            ),
          ];
        },
      },
      prefillDelayMs: 6000,
      // v2 lists its models and agents through its server API; the watcher
      // applies the pick in the TUI (v2 has no launch flag for either).
      models: async (ctx) =>
        (await isOpenCodeV2(ctx))
          ? openCodeV2Models(ctx)
          : parseOpenCodeModels(
              await execFirst(
                ctx,
                "opencode models --json 2>/dev/null || opencode models --verbose 2>/dev/null || opencode models 2>/dev/null",
              ),
            ),
      permissionModes: [],
      modes: async (ctx) =>
        (await isOpenCodeV2(ctx))
          ? openCodeV2Modes(ctx)
          : parseOpenCodeAgents(await execFirst(ctx, "opencode agent list 2>/dev/null")),
      slashCommands: slashCommandProvider(BUILTIN_SLASH_COMMANDS, SLASH_COMMAND_SOURCES, {
        acp: { command: ["opencode", "acp"] },
      }),
      args: OPENCODE_AGENT_ARGS,
    }),
  ],
});

export default opencodeAgentPlugin;

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({ cwd: pluginCwd(ctx), commands: [command] });
  return result?.stdout ?? "";
}

/**
 * Parses `opencode agent list` (`name (mode)` header lines, each followed by
 * its permission JSON) into the primary agents Tab cycles through, with
 * `build` and `plan` first. Falls back to those two when nothing parses.
 */
export function parseOpenCodeAgents(output: string): AgentMode[] {
  const names = output
    .replaceAll(ansiEscapePattern, "")
    .split("\n")
    .flatMap((line) => {
      const match = /^(\S+) \((primary|all|subagent)\)$/.exec(line.trim());
      return match && match[2] !== "subagent" && !HIDDEN_AGENTS.has(match[1]!) ? [match[1]!] : [];
    });
  if (names.length === 0) return DEFAULT_MODES;
  const rank = (name: string) => {
    const index = DEFAULT_MODES.findIndex((mode) => mode.id === name);
    return index === -1 ? DEFAULT_MODES.length : index;
  };
  return [...new Set(names)]
    .toSorted((a, b) => rank(a) - rank(b))
    .map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
}

/** Parses OpenCode's `models` output (JSON or table form) into model entries. */
export function parseOpenCodeModels(output: string): AgentModelEntry[] {
  const jsonModels = parseJsonModels(output);
  if (jsonModels.length > 0) {
    return jsonModels;
  }
  return output
    .replaceAll(ansiEscapePattern, "")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^│|│$/g, "")
        .trim(),
    )
    .flatMap(modelFromLine);
}

function modelFromLine(line: string): AgentModelEntry[] {
  if (isModelTableDecoration(line)) return [];
  const model = parseModelLine(line);
  return model ? [model] : [];
}

function parseModelLine(line: string): AgentModelEntry | null {
  const [id, name] = modelColumns(line);
  if (!id) return null;
  if (!name) return null;
  if (/\s/.test(id)) return null;
  return { id, name: withProvider(id, name) };
}

function modelColumns(line: string): [string | undefined, string | undefined] {
  if (!line.includes(" - ")) return splitWhitespaceModel(line);
  const [id, name] = line.split(" - ", 2);
  return [id, name];
}

function isModelTableDecoration(line: string): boolean {
  return !line || /^(model|provider|tip|usage)/i.test(line) || /^[─━│┃┌┐└┘├┤┬┴┼\-+]+$/.test(line);
}

function parseJsonModels(output: string): AgentModelEntry[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    const models: AgentModelEntry[] = [];
    walk(parsed, models);
    return uniqueModels(models);
  } catch {
    return [];
  }
}

// fallow-ignore-next-line complexity -- recursive JSON traversal must branch by array, record, and leaf shape.
function walk(value: unknown, models: AgentModelEntry[]): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, models);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const model = modelFromRecord(value);
  if (model) {
    models.push(model);
  }
  for (const child of Object.values(value)) walk(child, models);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function modelFromRecord(record: Record<string, unknown>): AgentModelEntry | null {
  const id = firstString(record.id, record.model);
  const name = modelName(record, id);
  if (!id || !name || !hasModelMetadata(record)) {
    return null;
  }
  return { id, name: withProvider(id, name, stringValue(record.provider)) };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = stringValue(value);
    if (string) return string;
  }
  return undefined;
}

function modelName(record: Record<string, unknown>, id: string | undefined): string | undefined {
  return (
    stringValue(record.name) ?? stringValue(record.displayName) ?? stringValue(record.label) ?? id
  );
}

function hasModelMetadata(record: Record<string, unknown>): boolean {
  return Boolean(record.provider || record.cost || record.limits || record.modalities);
}

function uniqueModels(models: AgentModelEntry[]): AgentModelEntry[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitWhitespaceModel(line: string): [string | undefined, string | undefined] {
  const parts = line.split(/\s+/);
  const id = parts[0];
  return id?.includes("/")
    ? [id, parts.slice(1).join(" ") || displayName(id)]
    : [undefined, undefined];
}

/**
 * Derives a readable name from a bare model id.
 *
 * OpenCode ids spell version dots as hyphens (`claude-opus-4-5` is Opus 4.5),
 * so a blanket hyphen-to-space rewrite silently drops the dot from the version
 * number. A hyphen sitting between two digits becomes `.`; every other
 * separator becomes a space.
 */
function displayName(id: string): string {
  const bare = id.split("/").at(-1);
  if (!bare) {
    return id;
  }
  return bare.replaceAll(/(?<=\d)-(?=\d)/g, ".").replaceAll(/[-_]/g, " ");
}

function withProvider(
  id: string,
  name: string,
  provider = id.includes("/") ? id.split("/", 1)[0] : "",
): string {
  return provider && !name.endsWith(`(${provider})`) ? `${name} (${provider})` : name;
}
