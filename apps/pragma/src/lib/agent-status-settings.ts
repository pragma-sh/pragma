import { constants, type AgentStatusSettings } from "@pragma/constants";

import { readAgentSound, readConfig, type ConfigScope } from "@/lib/tauri";

/** The agent alert settings that apply after layering project over global. */
export interface EffectiveAgentStatusSettings {
  notificationsEnabled: boolean;
  /** Clip to play on every alert, or null for the built-in chime. */
  soundName: string | null;
  /** Scope the clip is read from; project clips take precedence. */
  soundScope: ConfigScope;
}

const CONFIG_CHANGED_EVENT = "pragma:config-changed";

// Reading two config files per alert would add IPC to a latency-sensitive path,
// so the resolved settings are cached per project until a Settings save fires
// `pragma:config-changed`.
const settingsByProject = new Map<string, Promise<EffectiveAgentStatusSettings>>();
const soundBuffers = new Map<string, Promise<AudioBuffer | null>>();
let sharedContext: AudioContext | null = null;
let listeningForConfigChanges = false;

/**
 * Validates the `agentStatus` block of a `.pragma/config.json`. Throws so a
 * malformed block surfaces in Settings instead of silently disabling alerts.
 */
export function validateAgentStatusSettings(value: unknown): AgentStatusSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agentStatus must be an object");
  }
  const settings = value as AgentStatusSettings;
  if (
    settings.notificationsEnabled !== undefined &&
    typeof settings.notificationsEnabled !== "boolean"
  ) {
    throw new Error("agentStatus.notificationsEnabled must be a boolean");
  }
  if (
    settings.soundName !== undefined &&
    settings.soundName !== null &&
    typeof settings.soundName !== "string"
  ) {
    throw new Error("agentStatus.soundName must be a string or null");
  }
  return settings;
}

/** Layers project settings over global ones over the shipped defaults. */
export function mergeAgentStatusSettings(
  global: AgentStatusSettings,
  project: AgentStatusSettings,
): EffectiveAgentStatusSettings {
  const soundName = project.soundName ?? global.soundName ?? null;
  return {
    notificationsEnabled:
      project.notificationsEnabled ??
      global.notificationsEnabled ??
      constants.agentStatus.notificationsEnabled,
    soundName,
    soundScope: project.soundName ? "project" : "global",
  };
}

/** Drops cached settings and decoded clips after a Settings save. */
export function resetAgentStatusSettingsCache(): void {
  settingsByProject.clear();
  soundBuffers.clear();
}

function watchConfigChanges(): void {
  if (listeningForConfigChanges || typeof window === "undefined") return;
  listeningForConfigChanges = true;
  window.addEventListener(CONFIG_CHANGED_EVENT, resetAgentStatusSettingsCache);
}

async function readScopeSettings(
  scope: ConfigScope,
  projectId?: string | null,
): Promise<AgentStatusSettings> {
  try {
    const document = await readConfig(scope, projectId);
    const parsed = JSON.parse(document.contents || "{}") as { agentStatus?: unknown };
    return validateAgentStatusSettings(parsed.agentStatus);
  } catch {
    // An unreadable or malformed config must not silence alerts entirely.
    return {};
  }
}

/** Resolves the alert settings for a project (or the global ones without one). */
export function agentStatusSettings(
  projectId?: string | null,
): Promise<EffectiveAgentStatusSettings> {
  watchConfigChanges();
  const key = projectId ?? "";
  const cached = settingsByProject.get(key);
  if (cached) return cached;
  const resolved = (async () => {
    const [global, project] = await Promise.all([
      readScopeSettings("global"),
      projectId ? readScopeSettings("project", projectId) : Promise.resolve({}),
    ]);
    return mergeAgentStatusSettings(global, project);
  })();
  settingsByProject.set(key, resolved);
  return resolved;
}

function audioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  sharedContext = new AudioContextCtor();
  return sharedContext;
}

/** Decodes base64 clip bytes into the buffer the Web Audio API plays. */
function decodeBase64(contents: string): ArrayBuffer {
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** Reads and decodes one clip, or null when it is missing or not audio. */
async function decodeSound(
  context: AudioContext,
  scope: ConfigScope,
  name: string,
  projectId?: string | null,
): Promise<AudioBuffer | null> {
  try {
    const encoded = await readAgentSound(scope, name, projectId);
    return await context.decodeAudioData(decodeBase64(encoded));
  } catch {
    return null;
  }
}

/**
 * Loads and decodes a clip, preferring the project's sounds directory and
 * falling back to the global one so a project can reference a shared clip.
 */
function loadSoundBuffer(
  name: string,
  scope: ConfigScope,
  projectId?: string | null,
): Promise<AudioBuffer | null> {
  const key = `${scope}:${projectId ?? ""}:${name}`;
  const cached = soundBuffers.get(key);
  if (cached) return cached;
  const loaded = (async () => {
    const context = audioContext();
    if (!context) return null;
    if (scope === "project" && projectId) {
      const fromProject = await decodeSound(context, "project", name, projectId);
      if (fromProject) return fromProject;
    }
    return decodeSound(context, "global", name, projectId);
  })();
  soundBuffers.set(key, loaded);
  return loaded;
}

/**
 * Plays the configured alert clip. Returns false when no clip is configured or
 * it could not be played, so the caller can fall back to the built-in chime.
 * Playback is capped at the shared clip limit, so a hand-copied long file cannot
 * turn an alert into background music.
 */
export async function playAgentAlertSound(
  settings: EffectiveAgentStatusSettings,
  projectId?: string | null,
): Promise<boolean> {
  if (!settings.soundName) return false;
  try {
    const buffer = await loadSoundBuffer(settings.soundName, settings.soundScope, projectId);
    const context = audioContext();
    if (!buffer || !context) return false;
    if (context.state === "suspended") await context.resume();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    source.stop(context.currentTime + constants.agentStatus.maxSoundSeconds);
    return true;
  } catch {
    return false;
  }
}
