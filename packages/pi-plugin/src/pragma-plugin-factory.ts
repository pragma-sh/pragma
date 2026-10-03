import {
  credentialStoreAccount,
  defineAgent,
  type AccountLogin,
  type AccountProviderDefinition,
  type StoredSharedTokenOptions,
  type CredentialStore,
  definePlugin,
  type AgentFeature,
  type AgentModelEntry,
  type PluginContext,
  type PluginDefinition,
} from "@pragma-sh/plugin/catalog";
import { createTuiWatcher } from "@pragma-sh/watcher-kit";

const KITTY_ENTER = "\x1b[13u";
const KITTY_ALT_ENTER = "\x1b[13;3u";
const CLEAR_INPUT = "\x15";
const PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
  (id) => ({ id, name: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase()}${id.slice(1)}` }),
);

/**
 * Pi's sign-ins, keyed by Pragma's well-known provider, with their entries in
 * its `auth.json` (pi-ai provider ids), most specific first. `/login` covers
 * the ChatGPT and Copilot subscriptions; every other entry is an API key.
 *
 * Anthropic is key-only: Claude Free/Pro/Max OAuth may only be used in Claude
 * Code and claude.ai, so Pi's Claude sign-in is never presented as an account.
 * Google is the Gemini API key, never Gemini CLI or Antigravity OAuth.
 */
export const PI_ACCOUNT_ENTRIES: ReadonlyArray<{
  provider: string;
  entries: readonly string[];
  apiKeyOnly?: boolean;
  /** The OAuth sign-in other harnesses can share; every API key is shared anyway. */
  sharedToken?: StoredSharedTokenOptions;
}> = [
  {
    provider: "openai",
    entries: ["openai-codex", "openai"],
    // Same OAuth client as Codex and OpenCode.
    sharedToken: { kind: "chatgpt", entry: "openai-codex", type: "oauth" },
  },
  { provider: "anthropic", entries: ["anthropic"], apiKeyOnly: true },
  {
    provider: "github-copilot",
    entries: ["github-copilot"],
    // pi-ai signs in through VS Code's GitHub OAuth app; only harnesses on the
    // same app (Pi, Prime Agent) exchange the sign-in.
    sharedToken: {
      kind: "github-copilot:Iv1.b507a08c87ecfe98",
      entry: "github-copilot",
      type: "oauth",
    },
  },
  { provider: "opencode-go", entries: ["opencode-go"] },
  { provider: "opencode-zen", entries: ["opencode"], apiKeyOnly: true },
  { provider: "google", entries: ["google"], apiKeyOnly: true },
  { provider: "xai", entries: ["xai"], apiKeyOnly: true },
  { provider: "openrouter", entries: ["openrouter"], apiKeyOnly: true },
  { provider: "deepseek", entries: ["deepseek"], apiKeyOnly: true },
  { provider: "groq", entries: ["groq"], apiKeyOnly: true },
  { provider: "mistral", entries: ["mistral"], apiKeyOnly: true },
  { provider: "cerebras", entries: ["cerebras"], apiKeyOnly: true },
  { provider: "fireworks", entries: ["fireworks"], apiKeyOnly: true },
  { provider: "together", entries: ["together"], apiKeyOnly: true },
  { provider: "huggingface", entries: ["huggingface"], apiKeyOnly: true },
  { provider: "nvidia", entries: ["nvidia"], apiKeyOnly: true },
  { provider: "vercel-ai-gateway", entries: ["vercel-ai-gateway"], apiKeyOnly: true },
  { provider: "zai", entries: ["zai", "zai-coding-cn"], apiKeyOnly: true },
  { provider: "minimax", entries: ["minimax", "minimax-cn"], apiKeyOnly: true },
  { provider: "moonshot", entries: ["kimi-coding"], apiKeyOnly: true },
  { provider: "moonshot-platform", entries: ["moonshotai", "moonshotai-cn"], apiKeyOnly: true },
  {
    provider: "xiaomi",
    entries: ["xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp", "xiaomi-token-plan-cn"],
    apiKeyOnly: true,
  },
];

/**
 * How a Pi-family CLI signs in to a provider from inside its TUI, keyed by
 * Pragma's well-known provider. Pragma opens the CLI in a hidden terminal and
 * types `input` into it (see `AccountLogin.input`).
 */
export type PiAccountLogins = Partial<Record<string, AccountLogin>>;

/**
 * Account providers for a Pi-family CLI: one per sign-in in its `auth.json`.
 *
 * Every provider shares the one agent directory, which also holds the Pragma
 * extension and settings, so no provider can take a Pragma-owned directory
 * (`env`) of its own. Every provider instead switches accounts by swapping its
 * entries in `auth.json` at launch, and lends its sign-in to other harnesses:
 * any API key, plus the ChatGPT and Copilot OAuth sign-ins (see
 * `PI_ACCOUNT_ENTRIES`). A provider with a scripted `/login` in `logins` can
 * also sign in to another account from Pragma. The providers identify each
 * sign-in so it merges with the Codex, Copilot, OpenCode, and other accounts
 * it belongs to.
 */
export function piAccountProviders(
  agentId: string,
  store: CredentialStore,
  logins: PiAccountLogins = {},
): AccountProviderDefinition[] {
  return PI_ACCOUNT_ENTRIES.map(({ provider, entries, apiKeyOnly, sharedToken }) => {
    const login = apiKeyOnly ? undefined : logins[provider];
    return credentialStoreAccount({
      provider,
      agent: agentId,
      store,
      entries,
      apiKeyOnly,
      ...(login ? { login } : {}),
      ...(sharedToken ? { sharedToken } : {}),
    });
  });
}

/** Product-specific settings for one Pragma launcher backed by a Pi-compatible CLI. */
export interface PiPragmaPluginOptions {
  plugin: {
    name: string;
    description: string;
  };
  agent: {
    id: string;
    name: string;
    iconPath: string;
    command: string[];
    modelListCommand: string;
    excludeFeatures: AgentFeature[];
  };
  /** Account providers the CLI signs in to (see `defineAccounts`). */
  accounts?: AccountProviderDefinition[];
}

/** Creates a branded Pragma launcher for a Pi-compatible coding agent. */
export function createPiPragmaPlugin(options: PiPragmaPluginOptions): PluginDefinition {
  const { agent } = options;
  const baseWatcher = createTuiWatcher({
    agent: agent.id,
    handleDecisions: false,
    // Pi queues a mid-turn follow-up with Alt+Enter. Plain Enter inserts a
    // newline while a response is streaming.
    interjectSubmitKeys: KITTY_ALT_ENTER,
  });

  return definePlugin({
    name: options.plugin.name,
    description: options.plugin.description,
    accounts: options.accounts,
    watchers: [
      {
        agent: agent.id,
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
        id: agent.id,
        name: agent.name,
        icon: () => null,
        iconPath: agent.iconPath,
        launch: { command: agent.command },
        excludeFeatures: agent.excludeFeatures,
        // Pi's 100ms OSC 11 theme probe can expire before Pragma relays the
        // terminal response, leaving the late response in the composer. Clear
        // it immediately before prompt prefill.
        startupInput: [{ delayMs: 1800, data: CLEAR_INPUT }],
        prefillDelayMs: 2000,
        prefillMode: "plain",
        prefillSubmit: KITTY_ENTER,
        models: async (ctx) => parsePiModels(await execFirst(ctx, agent.modelListCommand)),
        permissionModes: [],
        args: {
          model: (modelId: string) => ["--model", modelId],
          reasoning: (reasoningId: string) => ["--thinking", reasoningId],
          modelReasoning: (modelId: string, reasoningId: string) => [
            "--model",
            modelId,
            "--thinking",
            reasoningId,
          ],
          permissionMode: () => [],
        },
      }),
    ],
  });
}

async function execFirst(ctx: PluginContext, command: string): Promise<string> {
  const [result] = await ctx.sdk.exec.run({
    cwd: ctx.project?.path ?? "/tmp",
    commands: [command],
  });
  return result?.stdout ?? "";
}

const YES_NO = new Set(["yes", "no"]);

function isPiModelRow(
  fields: string[],
): fields is [string, string, string, string, string, string] {
  if (fields.length !== 6 || fields.some((field) => field === "")) return false;
  const [provider, , , , thinking, images] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (provider === "provider") return false;
  return YES_NO.has(thinking) && YES_NO.has(images);
}

function parsePiModelLine(line: string): AgentModelEntry | null {
  const fields = line.trim().split(/\s+/);
  if (!isPiModelRow(fields)) return null;
  const [provider, model, , , thinking] = fields;
  const entry: AgentModelEntry = {
    id: `${provider}/${model}`,
    name: `${model} (${provider})`,
  };
  if (thinking === "yes") entry.reasoning = PI_REASONING_LEVELS;
  return entry;
}

/** Parses a Pi-compatible six-column model table into launcher entries. */
export function parsePiModels(output: string): AgentModelEntry[] {
  return output
    .split("\n")
    .map(parsePiModelLine)
    .filter((entry): entry is AgentModelEntry => entry !== null);
}
