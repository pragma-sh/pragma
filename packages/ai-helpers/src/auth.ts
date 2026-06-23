import { getProviders, type OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * A single authorization method shown on the AI setup screen.
 *
 * - `oauth` methods log in to a subscription (Claude Pro/Max, ChatGPT, GitHub
 *   Copilot) via a browser/device flow.
 * - `api-key` methods store a pasted provider API key.
 *
 * `featured` methods are surfaced prominently; the rest live behind a
 * "More options" reveal.
 */
export interface AiAuthMethod {
  /** Provider id used with `AuthStorage` (e.g. "anthropic", "github-copilot"). */
  provider: string;
  /** Human-facing label. */
  label: string;
  kind: "oauth" | "api-key";
  featured: boolean;
}

/** The OAuth subscription providers pi registers by default. */
const OAUTH_PROVIDER_IDS = new Set(["anthropic", "openai-codex", "github-copilot"]);

/**
 * The methods to highlight on the setup screen, in display order. Each entry
 * pins a specific `(provider, kind)` pair so e.g. "Claude Code" is the Anthropic
 * subscription sign-in, not the Anthropic API key.
 */
const FEATURED_METHODS: ReadonlyArray<Omit<AiAuthMethod, "featured">> = [
  { provider: "anthropic", kind: "oauth", label: "Claude Code (Claude Pro/Max)" },
  { provider: "openai-codex", kind: "oauth", label: "Codex (ChatGPT Plus/Pro)" },
  { provider: "openrouter", kind: "api-key", label: "OpenRouter" },
  { provider: "github-copilot", kind: "oauth", label: "GitHub Copilot" },
  { provider: "google", kind: "api-key", label: "Google AI (Gemini)" },
  { provider: "opencode-go", kind: "api-key", label: "opencode Go" },
];

/** Providers that authenticate via ambient cloud/OAuth credentials, not a pasted key. */
const API_KEY_EXCLUDE = new Set([
  "amazon-bedrock",
  "google-vertex",
  "azure-openai-responses",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "github-copilot",
  "openai-codex",
]);

/** Friendly labels for API-key providers; unlisted ids are title-cased. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI (Grok)",
  groq: "Groq",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  openrouter: "OpenRouter",
  opencode: "opencode Zen",
  "opencode-go": "opencode Go",
  cerebras: "Cerebras",
  fireworks: "Fireworks",
  together: "Together AI",
  huggingface: "Hugging Face",
  nvidia: "NVIDIA NIM",
  "ant-ling": "Ant Ling",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  "kimi-coding": "Kimi for Coding",
  "vercel-ai-gateway": "Vercel AI Gateway",
  zai: "Z.AI",
  "zai-coding-cn": "Z.AI Coding (China)",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-ams": "Xiaomi Token Plan (Amsterdam)",
  "xiaomi-token-plan-cn": "Xiaomi Token Plan (China)",
  "xiaomi-token-plan-sgp": "Xiaomi Token Plan (Singapore)",
};

function methodKey(method: { provider: string; kind: string }): string {
  return `${method.kind}:${method.provider}`;
}

function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ??
    provider
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/** Create the default `AuthStorage` (`~/.pi/agent/auth.json`). */
export function createAuthStorage(authPath?: string): AuthStorage {
  return AuthStorage.create(authPath);
}

/** Create a `ModelRegistry` bound to the given auth storage. */
export function createModelRegistry(
  authStorage: AuthStorage,
  modelsJsonPath?: string,
): ModelRegistry {
  return ModelRegistry.create(authStorage, modelsJsonPath);
}

/**
 * Every authorization method to present on the setup screen. Featured methods
 * come first (in {@link FEATURED_METHODS} order); the remaining OAuth and
 * API-key methods follow alphabetically for the "More options" reveal.
 */
export function listAuthMethods(): AiAuthMethod[] {
  const featuredKeys = new Set(FEATURED_METHODS.map(methodKey));

  const featured: AiAuthMethod[] = FEATURED_METHODS.map((method) => ({
    provider: method.provider,
    label: method.label,
    kind: method.kind,
    featured: true,
  }));

  const rest: AiAuthMethod[] = [];
  for (const provider of OAUTH_PROVIDER_IDS) {
    if (featuredKeys.has(`oauth:${provider}`)) continue;
    rest.push({ provider, label: providerLabel(provider), kind: "oauth", featured: false });
  }
  for (const provider of getProviders()) {
    if (API_KEY_EXCLUDE.has(provider) || featuredKeys.has(`api-key:${provider}`)) continue;
    rest.push({ provider, label: providerLabel(provider), kind: "api-key", featured: false });
  }
  rest.sort((a, b) => a.label.localeCompare(b.label));

  return [...featured, ...rest];
}

/** Providers the user currently has credentials stored for. */
export function signedInProviders(authStorage: AuthStorage): string[] {
  return authStorage.list();
}

/**
 * Whether any AI feature can run — i.e. at least one authenticated provider
 * exposes a usable model. This is the gate for showing AI affordances in the UI.
 */
export function isAiAvailable(registry: ModelRegistry): boolean {
  return registry.getAvailable().length > 0;
}

/**
 * Run the OAuth login flow for a subscription provider. The `callbacks` carry
 * the interactive steps (open URL, show device code, prompt for input) back to
 * the caller.
 */
export function loginOAuth(
  authStorage: AuthStorage,
  provider: string,
  callbacks: OAuthLoginCallbacks,
): Promise<void> {
  return authStorage.login(provider, callbacks);
}

/** Store an API key for a provider (persisted to `auth.json`). */
export function setApiKey(authStorage: AuthStorage, provider: string, apiKey: string): void {
  authStorage.set(provider, { type: "api_key", key: apiKey });
}

/** Remove all stored credentials for a provider. */
export function logout(authStorage: AuthStorage, provider: string): void {
  authStorage.logout(provider);
}
