import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import {
  ArrowLeft,
  BellRing,
  Blocks,
  Clock,
  Keyboard,
  LogOut,
  Palette,
  RefreshCw,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  constants,
  type AgentStatusSettings,
  type GitHubAuthMethod,
  type TerminalSettings,
} from "@pragma/constants";

import { AiAuthOptions } from "@/components/ai/AiAuthOptions";
import { AutomationsWorkspace } from "@/components/automations/AutomationsWorkspace";
import { PragmaGoSettings } from "@/components/dialogs/PairDeviceDialog";
import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { AgentStatusSection } from "@/components/settings/AgentStatusSection";
import { KeybindingsSection } from "@/components/settings/KeybindingsSection";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { TerminalSection } from "@/components/settings/TerminalSection";
import { ThemeSection } from "@/components/settings/ThemeSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TERMINAL_SETTINGS_CHANGED_EVENT } from "@/hooks/use-terminal-settings";
import { validateAgentStatusSettings } from "@/lib/agent-status-settings";
import { errorMessage } from "@/lib/errors";
import {
  aiAuthMethods,
  aiLogout,
  gatewayDevices,
  readConfig,
  readPluginManifests,
  writeConfig,
  type AiAuthMethod,
  type ConfigScope,
  type GatewayDevice,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { startWindowDrag } from "@/lib/window-drag";
import { useAi } from "@/state/ai-context";
import { useGitHub } from "@/state/github-context";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

type Section =
  | "plugins"
  | "keybindings"
  | "theme"
  | "terminal"
  | "agentStatus"
  | "github"
  | "ai"
  | "mobile"
  | "automations";

/** Sections that read and write per-project settings as well as global ones. */
const PROJECT_SECTIONS: ReadonlySet<Section> = new Set<Section>([
  "plugins",
  "keybindings",
  "theme",
  "terminal",
  "agentStatus",
]);

const SECTIONS: ReadonlySet<string> = new Set<Section>([
  "plugins",
  "keybindings",
  "theme",
  "terminal",
  "agentStatus",
  "github",
  "ai",
  "mobile",
  "automations",
]);

/** Narrows the `openSettings` target to a known section, defaulting to Plugins. */
function initialSection(raw: string | null): Section {
  return raw !== null && SECTIONS.has(raw) ? (raw as Section) : "plugins";
}

interface PluginConfig {
  path: string;
  config?: unknown;
}

interface PragmaConfig {
  plugins?: PluginConfig[];
  tunnel?: {
    enabled?: boolean;
    command?: string;
    urlPattern?: string;
    [key: string]: unknown;
  };
  gateway?: {
    webEnabled?: boolean;
    [key: string]: unknown;
  };
  agentStatus?: AgentStatusSettings;
  terminal?: TerminalSettings;
  [key: string]: unknown;
}

interface LoadedConfig {
  value: PragmaConfig;
}

type PersistConfig = (update: (current: PragmaConfig) => PragmaConfig) => Promise<void>;

function parsePragmaConfig(contents: string): PragmaConfig {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config.json root must be an object");
  }
  const config = value as PragmaConfig;
  validatePlugins(config.plugins);
  validateTunnel(config.tunnel);
  validateGateway(config.gateway);
  validateTerminal(config.terminal);
  validateAgentStatusSettings(config.agentStatus);
  return config;
}

function validateGateway(gateway: PragmaConfig["gateway"]): void {
  if (gateway === undefined) return;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    throw new Error("gateway must be an object");
  }
  validateOptionalField(gateway.webEnabled, "gateway.webEnabled", "boolean");
}

function validateTerminal(terminal: PragmaConfig["terminal"]): void {
  if (terminal === undefined) return;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
    throw new Error("terminal must be an object");
  }
  validateBackend(terminal.backend);
  validateDistro(terminal.distro);
  validateOptionalField(terminal.shell, "terminal.shell", "string");
  if (terminal.hiddenDistros !== undefined && !Array.isArray(terminal.hiddenDistros)) {
    throw new Error("terminal.hiddenDistros must be an array");
  }
}

/** The two shell worlds; anything else is a typo the user needs to see. */
function validateBackend(backend: TerminalSettings["backend"]): void {
  if (backend !== undefined && backend !== "native" && backend !== "wsl") {
    throw new Error('terminal.backend must be "native" or "wsl"');
  }
}

/** Null is meaningful here — it selects whichever distribution WSL calls default. */
function validateDistro(distro: TerminalSettings["distro"]): void {
  if (distro !== undefined && distro !== null && typeof distro !== "string") {
    throw new Error("terminal.distro must be a string or null");
  }
}

function validatePlugins(plugins: PragmaConfig["plugins"]): void {
  if (plugins === undefined) return;
  if (!Array.isArray(plugins)) throw new Error("plugins must be an array");
  for (const [index, plugin] of plugins.entries()) validatePlugin(plugin, index);
}

// fallow-ignore-next-line complexity -- validates each independent persisted plugin field.
function validatePlugin(plugin: PluginConfig, index: number): void {
  if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
    throw new Error(`plugins[${index}] must be an object`);
  }
  if (typeof plugin.path !== "string" || !plugin.path.trim()) {
    throw new Error(`plugins[${index}].path must be a non-empty string`);
  }
  if (
    plugin.config !== undefined &&
    (!plugin.config || typeof plugin.config !== "object" || Array.isArray(plugin.config))
  ) {
    throw new Error(`plugins[${index}].config must be an object`);
  }
}

function validateTunnel(tunnel: PragmaConfig["tunnel"]): void {
  if (tunnel === undefined) return;
  if (!tunnel || typeof tunnel !== "object" || Array.isArray(tunnel)) {
    throw new Error("tunnel must be an object");
  }
  validateOptionalField(tunnel.enabled, "tunnel.enabled", "boolean");
  validateOptionalField(tunnel.command, "tunnel.command", "string");
  validateOptionalField(tunnel.urlPattern, "tunnel.urlPattern", "string");
}

/**
 * Rejects a config field that is present but of the wrong type. Absent is
 * always allowed: every field of every block here is optional, and a missing
 * one means "use the default".
 */
function validateOptionalField(value: unknown, name: string, type: "boolean" | "string"): void {
  if (value !== undefined && typeof value !== type) {
    throw new Error(`${name} must be a ${type}`);
  }
}

// fallow-ignore-next-line complexity -- coordinates settings loading, queued persistence, and scope constraints.
export function SettingsWorkspace() {
  const workspace = useWorkspace();
  const shell = useKanban();
  const [scope, setScope] = useState<ConfigScope>("global");
  const [section, setSection] = useState<Section>(() => initialSection(shell.settingsSection));
  const [loaded, setLoaded] = useState<LoadedConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadGeneration = useRef(0);
  const latestConfig = useRef<PragmaConfig | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  // Honor deep-links while Settings is already mounted (command palette / menu).
  useEffect(() => {
    if (shell.settingsSection === null) return;
    const next = initialSection(shell.settingsSection);
    setSection(next);
    if (!PROJECT_SECTIONS.has(next)) setScope("global");
  }, [shell.settingsSection]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const document = await readConfig(scope, workspace.selectedProjectId);
      if (generation !== loadGeneration.current) return;
      const value = parsePragmaConfig(document.contents);
      latestConfig.current = value;
      setLoaded({ value });
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      latestConfig.current = null;
      setLoaded(null);
      setError(errorMessage(cause));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [scope, workspace.selectedProjectId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (scope === "project" && !workspace.selectedProjectId) setScope("global");
    // GitHub, AI, mobile, and automations are app-global, so project scope falls
    // back to the first section that has a project layer.
    if (scope === "project" && !PROJECT_SECTIONS.has(section)) setSection("plugins");
  }, [scope, section, workspace.selectedProjectId]);

  const persist = useCallback(
    async (update: (current: PragmaConfig) => PragmaConfig) => {
      const current = latestConfig.current;
      if (!current) throw new Error("Settings are not loaded");
      const value = update(current);
      latestConfig.current = value;
      const contents = `${JSON.stringify(value, null, 2)}\n`;
      const targetScope = scope;
      const targetProjectId = workspace.selectedProjectId;
      setLoaded((loadedConfig) =>
        loadedConfig
          ? {
              value,
            }
          : loadedConfig,
      );
      const write = saveQueue.current.then(() =>
        writeConfig(targetScope, contents, targetProjectId),
      );
      saveQueue.current = write.catch(() => undefined);
      try {
        await write;
        window.dispatchEvent(new Event("pragma:config-changed"));
        toast.success("Settings saved");
      } catch (cause) {
        toast.error(errorMessage(cause));
        void load();
        throw cause;
      }
    },
    [load, scope, workspace.selectedProjectId],
  );

  return (
    <section className="bg-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- native titlebar drag region */}
      <header
        className="flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 pt-[calc(var(--titlebar-height,0px)+0.75rem)] pb-3"
        onMouseDown={startWindowDrag}
      >
        <div className="flex items-center gap-3">
          <Button
            aria-label="Back to workspace"
            size="icon-sm"
            variant="ghost"
            onClick={shell.closeSettings}
          >
            <ArrowLeft />
          </Button>
          <div>
            <h1 className="text-sm font-semibold">Settings</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Configure Pragma globally or for {workspace.activeProject?.name ?? "current project"}.
            </p>
          </div>
        </div>
        <ScopeToggle
          scope={scope}
          projectDisabled={!workspace.selectedProjectId}
          onChange={setScope}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <SettingsNavigation scope={scope} section={section} setSection={setSection} />
        <SettingsContent
          error={error}
          loaded={loaded}
          loading={loading}
          persist={persist}
          projectId={workspace.selectedProjectId}
          projectPath={workspace.activeProject?.path ?? null}
          reload={load}
          scope={scope}
          section={section}
          worktreeId={workspace.selectedWorktree?.id ?? null}
        />
      </div>
    </section>
  );
}

function SettingsNavigation({
  scope,
  section,
  setSection,
}: {
  scope: ConfigScope;
  section: Section;
  setSection: (section: Section) => void;
}) {
  return (
    <aside className="w-64 shrink-0 border-r border-sidebar-border bg-sidebar p-3">
      <SettingsNavItem
        active={section === "plugins"}
        icon={<Blocks />}
        onClick={() => setSection("plugins")}
      >
        Plugins
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "keybindings"}
        icon={<Keyboard />}
        onClick={() => setSection("keybindings")}
      >
        Keybindings
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "theme"}
        icon={<Palette />}
        onClick={() => setSection("theme")}
      >
        Theme
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "terminal"}
        icon={<SquareTerminal />}
        onClick={() => setSection("terminal")}
      >
        Terminal
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "agentStatus"}
        icon={<BellRing />}
        onClick={() => setSection("agentStatus")}
      >
        Agent Status
      </SettingsNavItem>
      {scope === "global" ? (
        <GlobalSettingsNavigation section={section} setSection={setSection} />
      ) : null}
    </aside>
  );
}

function GlobalSettingsNavigation({
  section,
  setSection,
}: Omit<Parameters<typeof SettingsNavigation>[0], "scope">) {
  return (
    <>
      <SettingsNavItem
        active={section === "github"}
        icon={<Icon icon="simple-icons:github" />}
        onClick={() => setSection("github")}
      >
        GitHub
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "ai"}
        icon={<Sparkles />}
        onClick={() => setSection("ai")}
      >
        AI Providers
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "mobile"}
        icon={<Smartphone />}
        onClick={() => setSection("mobile")}
      >
        Pragma Go
      </SettingsNavItem>
      <SettingsNavItem
        active={section === "automations"}
        icon={<Clock />}
        onClick={() => setSection("automations")}
      >
        Automations
      </SettingsNavItem>
    </>
  );
}

// fallow-ignore-next-line complexity -- selects one mutually exclusive settings panel from state.
function SettingsContent({
  error,
  loaded,
  loading,
  persist,
  projectId,
  projectPath,
  reload,
  scope,
  section,
  worktreeId,
}: {
  error: string | null;
  loaded: LoadedConfig | null;
  loading: boolean;
  persist: PersistConfig;
  projectId: string | null;
  projectPath: string | null;
  reload: () => Promise<void>;
  scope: ConfigScope;
  section: Section;
  worktreeId: string | null;
}) {
  // The Theme page reads `.pragma/theme.json`, not the `config.json` document
  // the rest of Settings loads, so it renders past that load state.
  if (section === "theme") {
    return (
      <main className="min-w-0 flex-1 overflow-auto p-8">
        <div className="mx-auto max-w-3xl">
          <ThemeSection projectId={projectId} scope={scope} />
        </div>
      </main>
    );
  }
  // Automations manages its own data (the automations context, not
  // config.json), so it also renders past the config load state.
  if (section === "automations" && scope === "global") {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
        <AutomationsWorkspace embedded />
      </main>
    );
  }
  return (
    <main className="min-w-0 flex-1 overflow-auto p-8">
      <div className="mx-auto max-w-3xl">
        {loading ? <p className="text-sm text-muted-foreground">Loading settings…</p> : null}
        {error ? <SettingsLoadError error={error} reload={reload} /> : null}
        {loaded && section === "plugins" ? (
          <PluginsSection
            config={loaded.value}
            persist={persist}
            projectPath={projectPath}
            scope={scope}
          />
        ) : null}
        {section === "keybindings" ? (
          <KeybindingsSection projectId={projectId} scope={scope} />
        ) : null}
        {loaded && section === "terminal" ? (
          <TerminalSection
            persist={async (patch) => {
              await persist((current) => ({
                ...current,
                terminal: { ...current.terminal, ...patch },
              }));
              // The new-tab menu marks the configured default; tell it to
              // re-read rather than waiting for the workspace to remount.
              window.dispatchEvent(new Event(TERMINAL_SETTINGS_CHANGED_EVENT));
            }}
            settings={loaded.value.terminal ?? {}}
            // Project-scoped settings describe the machine that project's
            // terminals run on, which for an SSH project is not this one.
            worktreeId={scope === "project" ? worktreeId : null}
          />
        ) : null}
        {loaded && section === "agentStatus" ? (
          <AgentStatusSection
            persist={(patch) =>
              persist((current) => ({
                ...current,
                agentStatus: { ...current.agentStatus, ...patch },
              }))
            }
            projectId={projectId}
            scope={scope}
            settings={loaded.value.agentStatus ?? {}}
          />
        ) : null}
        {section === "github" && scope === "global" ? <GitHubSection /> : null}
        {section === "ai" && scope === "global" ? <AiProvidersSection /> : null}
        {loaded && section === "mobile" && scope === "global" ? (
          <MobileSection config={loaded.value} persist={persist} />
        ) : null}
      </div>
    </main>
  );
}

function SettingsLoadError({ error, reload }: { error: string; reload: () => Promise<void> }) {
  return (
    <SettingsCard title="config.json needs attention">
      <p className="text-sm text-destructive">{error}</p>
      <Button className="mt-4" variant="ghost" onClick={() => void reload()}>
        <RefreshCw /> Reload
      </Button>
    </SettingsCard>
  );
}

function ScopeToggle({
  scope,
  projectDisabled,
  onChange,
}: {
  scope: ConfigScope;
  projectDisabled: boolean;
  onChange: (scope: ConfigScope) => void;
}) {
  return (
    <div className="flex rounded-lg border bg-background p-0.5" aria-label="Settings scope">
      <Button
        size="sm"
        variant={scope === "global" ? "secondary" : "ghost"}
        onClick={() => onChange("global")}
      >
        Global
      </Button>
      <Button
        size="sm"
        variant={scope === "project" ? "secondary" : "ghost"}
        disabled={projectDisabled}
        onClick={() => onChange("project")}
      >
        Project
      </Button>
    </div>
  );
}

function SettingsNavItem({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
        "[&_svg]:size-4",
      )}
      type="button"
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function PluginsSection({
  config,
  persist,
  projectPath,
  scope,
}: {
  config: PragmaConfig;
  persist: PersistConfig;
  projectPath: string | null;
  scope: ConfigScope;
}) {
  const plugins = config.plugins ?? [];
  const names = usePluginNames(projectPath, scope);

  async function remove(index: number): Promise<void> {
    await persist((current) => ({
      ...current,
      plugins: (current.plugins ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  return (
    <SettingsCard title="Loaded plugins" description={`Plugins loaded from ${scope} settings.`}>
      <div className="divide-y">
        {plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins loaded from this scope.</p>
        ) : null}
        {plugins.map((plugin, index) => {
          const name = names.get(plugin.path) ?? pluginNameFromPath(plugin.path);
          return (
            <div
              className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              key={pluginKey(plugins, index)}
            >
              <p className="min-w-0 truncate text-sm" title={plugin.path}>
                {name}
              </p>
              <Button
                aria-label={`Delete plugin ${name}`}
                className="shrink-0"
                size="icon-sm"
                variant="ghost"
                onClick={() => void remove(index)}
              >
                <Trash2 />
              </Button>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}

/**
 * Resolves configured plugin specifiers to their `package.json` names via the
 * manifest reader, keyed by the original config `path`. Entries that fail to
 * resolve simply stay absent (the list falls back to a path-derived name).
 */
function usePluginNames(projectPath: string | null, scope: ConfigScope): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      try {
        const entries = await readPluginManifests(projectPath);
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const entry of entries) {
          if (entry.scope === scope && entry.manifest) {
            next.set(entry.specifier, entry.manifest.name);
          }
        }
        setNames(next);
      } catch {
        // Name resolution is cosmetic; the path-derived fallback still renders.
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [projectPath, scope]);
  return names;
}

/** Last path segment of a plugin specifier — the fallback display name. */
function pluginNameFromPath(path: string): string {
  const segments = path.replace(/\/+$/, "").split("/");
  return segments.at(-1) || path;
}

function pluginKey(plugins: PluginConfig[], index: number): string {
  const plugin = plugins[index];
  if (!plugin) return "missing-plugin";
  const occurrence = plugins.slice(0, index).filter((item) => item.path === plugin.path).length;
  return `${plugin.path}:${occurrence}`;
}

/** Human-readable labels for the persisted GitHub auth method. */
const GITHUB_AUTH_METHOD_LABELS: Record<GitHubAuthMethod, string> = {
  deviceFlow: "OAuth device flow",
  cli: "GitHub CLI token",
};

function GitHubSection() {
  const { status, authenticated, loading, signOut } = useGitHub();
  const [signingOut, setSigningOut] = useState(false);

  const onSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      toast.success("Signed out of GitHub");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSigningOut(false);
    }
  }, [signOut]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading GitHub status…</p>;
  if (!authenticated) return <GitHubSignIn />;
  return <GitHubAccount status={status} signingOut={signingOut} onSignOut={onSignOut} />;
}

function GitHubSignIn() {
  return (
    <SettingsCard
      title="Connect GitHub"
      description="Manage pull requests, reviews, and merges without leaving your worktree."
    >
      <GitHubAuthOptions className="max-w-sm" />
    </SettingsCard>
  );
}

// fallow-ignore-next-line complexity -- account view conditionally renders available profile fields.
function GitHubAccount({
  status,
  signingOut,
  onSignOut,
}: {
  status: ReturnType<typeof useGitHub>["status"];
  signingOut: boolean;
  onSignOut: () => Promise<void>;
}) {
  const user = status?.user ?? null;
  const authMethod = status?.authMethod ?? null;
  return (
    <SettingsCard
      title="GitHub account"
      description="The account Pragma uses for pull requests, reviews, and merges."
    >
      <div className="flex items-center gap-4">
        {user?.avatarUrl ? (
          <img
            alt={`${user.login} avatar`}
            className="size-12 rounded-full border"
            src={user.avatarUrl}
          />
        ) : (
          <div className="inline-flex size-12 items-center justify-center rounded-full bg-muted">
            <Icon className="size-6" icon="simple-icons:github" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user?.name ?? user?.login ?? "Signed in"}</p>
          {user ? <p className="truncate text-xs text-muted-foreground">@{user.login}</p> : null}
        </div>
      </div>
      <dl className="mt-5 text-sm">
        <div className="flex items-center justify-between border-t py-3">
          <dt className="text-muted-foreground">Auth method</dt>
          <dd>{authMethod ? GITHUB_AUTH_METHOD_LABELS[authMethod] : "Unknown"}</dd>
        </div>
      </dl>
      <Button disabled={signingOut} variant="outline" onClick={() => void onSignOut()}>
        <LogOut /> Sign out
      </Button>
    </SettingsCard>
  );
}

/**
 * One connected AI provider, with the control that removes its credentials.
 *
 * Signing out matters more here than it looks: the pi credential store is shared
 * with the `pi` CLI, so a provider can appear connected that the user never
 * signed in to from Pragma — and model selection will happily route work to it.
 */
function AiProviderRow({ provider, label }: { provider: string; label: string }) {
  const { refresh } = useAi();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await aiLogout(provider);
      await refresh();
      toast.success(`Signed out of ${label}.`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      // The row normally unmounts on refresh; reset anyway so a backend that
      // reports the provider as still connected cannot leave a dead button.
      setSigningOut(false);
    }
  }, [provider, label, refresh]);

  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <p className="min-w-0 truncate text-sm">{label}</p>
      <Button
        aria-label={`Sign out of ${label}`}
        disabled={signingOut}
        onClick={() => void signOut()}
        size="sm"
        variant="outline"
      >
        <LogOut /> Sign out
      </Button>
    </div>
  );
}

function AiProvidersSection() {
  const { status } = useAi();
  const [methods, setMethods] = useState<AiAuthMethod[]>([]);
  const signedIn = status?.signedIn ?? [];

  useEffect(() => {
    aiAuthMethods().then(
      (loaded) => setMethods(Array.isArray(loaded) ? loaded : []),
      () => {
        // Labels are cosmetic; connected providers still render by id.
      },
    );
  }, []);

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Connected providers"
        description="Providers with stored credentials that power commit messages and other AI helpers. Credentials are shared with the pi CLI, so signing out here signs out there too."
      >
        {signedIn.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI providers connected yet.</p>
        ) : (
          <div className="divide-y">
            {signedIn.map((provider) => (
              <AiProviderRow
                key={provider}
                label={providerLabel(provider, methods)}
                provider={provider}
              />
            ))}
          </div>
        )}
      </SettingsCard>
      <SettingsCard
        title="Add a provider"
        description="Connect another provider with a subscription sign-in or an API key."
      >
        <AiAuthOptions />
      </SettingsCard>
    </div>
  );
}

/** Prefers the auth-method label for a provider id, falling back to the raw id. */
function providerLabel(provider: string, methods: AiAuthMethod[]): string {
  return methods.find((method) => method.provider === provider)?.label ?? provider;
}

function MobileSection({ config, persist }: { config: PragmaConfig; persist: PersistConfig }) {
  const tunnel = config.tunnel ?? {};
  const [command, setCommand] = useState(tunnel.command ?? constants.tunnel.defaultCommand);
  const [urlPattern, setUrlPattern] = useState(
    tunnel.urlPattern ?? constants.tunnel.defaultUrlPattern,
  );

  useEffect(() => {
    setCommand(tunnel.command ?? constants.tunnel.defaultCommand);
  }, [tunnel.command]);
  useEffect(() => {
    setUrlPattern(tunnel.urlPattern ?? constants.tunnel.defaultUrlPattern);
  }, [tunnel.urlPattern]);

  function saveTunnel(patch: Partial<NonNullable<PragmaConfig["tunnel"]>>): Promise<void> {
    return persist((current) => ({
      ...current,
      tunnel: { ...current.tunnel, ...patch },
    }));
  }

  return (
    <div className="space-y-5">
      <PragmaGoSettings
        webEnabled={config.gateway?.webEnabled ?? constants.gateway.web.enabled}
        onWebEnabledChange={(webEnabled) => {
          void persist((current) => ({
            ...current,
            gateway: { ...current.gateway, webEnabled },
          })).catch(() => undefined);
        }}
      />
      <GatewayDevices />
      <SettingsCard title="Tunnel" description="Advanced command used to expose local gateway.">
        <label className="text-sm font-medium" htmlFor="tunnel-command">
          Command
        </label>
        <Input
          id="tunnel-command"
          className="mt-1 font-mono text-xs"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onBlur={() => {
            if (command !== tunnel.command) void saveTunnel({ command }).catch(() => undefined);
          }}
        />
        <label className="mt-4 block text-sm font-medium" htmlFor="tunnel-url-pattern">
          URL pattern
        </label>
        <Input
          id="tunnel-url-pattern"
          className="mt-1 font-mono text-xs"
          value={urlPattern}
          onChange={(event) => setUrlPattern(event.target.value)}
          onBlur={() => {
            if (urlPattern !== tunnel.urlPattern)
              void saveTunnel({ urlPattern }).catch(() => undefined);
          }}
        />
      </SettingsCard>
    </div>
  );
}

function GatewayDevices() {
  const [devices, setDevices] = useState<GatewayDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setDevices(await gatewayDevices());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <SettingsCard
      title="Gateway devices"
      description="Mobile installations that successfully authenticated with this host."
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No devices have used this gateway yet.</p>
      ) : null}
      <div className="divide-y">
        {devices.map((device) => (
          <div
            className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
            key={device.id}
          >
            <div>
              <p className="text-sm font-medium">{device.name}</p>
              <p className="text-xs text-muted-foreground">
                {device.platform} · Pragma {device.appVersion}
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>Last used {formatSeen(device.lastSeenAt)}</p>
              <p className="font-mono">{device.id.slice(0, 10)}</p>
            </div>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

function formatSeen(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    timestamp,
  );
}
