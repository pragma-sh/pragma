import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Upload } from "lucide-react";
import { toast } from "sonner";

import { constants, type AgentSound, type AgentStatusSettings } from "@pragma/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/errors";
import { playAgentAlertSound, resetAgentStatusSettingsCache } from "@/lib/agent-status-settings";
import { importAgentSound, listAgentSounds, type ConfigScope } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Accepted audio types for the upload picker, derived from the shared limits. */
const ACCEPT = constants.agentStatus.soundExtensions.map((extension) => `.${extension}`).join(",");

/**
 * Notification and alert-sound settings for agent status changes. Both fields are
 * stored under `agentStatus` in the scope's `config.json`, so a project can use
 * its own clip (or silence notifications) without touching global settings.
 */
export function AgentStatusSection({
  settings,
  persist,
  scope,
  projectId,
}: {
  settings: AgentStatusSettings;
  persist: (patch: AgentStatusSettings) => Promise<void>;
  scope: ConfigScope;
  projectId: string | null;
}) {
  const notificationsEnabled =
    settings.notificationsEnabled ?? constants.agentStatus.notificationsEnabled;
  const selected = settings.soundName ?? null;
  const { dir, sounds, reload } = useAgentSounds(scope, projectId);

  const save = useCallback(
    async (patch: AgentStatusSettings) => {
      try {
        await persist(patch);
        resetAgentStatusSettingsCache();
      } catch {
        // `persist` already surfaced the failure and reloaded the config.
      }
    },
    [persist],
  );

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Agent notifications"
        description="What happens when an agent finishes or asks for your attention."
      >
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm" htmlFor="agent-notifications-enabled">
            Show platform notifications
            <span className="mt-1 block text-xs text-muted-foreground">
              Alerts still play a sound when notifications are off.
            </span>
          </label>
          <Switch
            checked={notificationsEnabled}
            id="agent-notifications-enabled"
            onCheckedChange={(checked) => void save({ notificationsEnabled: checked })}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Alert sound"
        description={`Clips in ${dir ?? constants.agentStatus.soundsDirName}. Uploads must be ${constants.agentStatus.maxSoundSeconds} seconds or shorter.`}
      >
        <div className="divide-y">
          <SoundRow
            label="Built-in chime"
            selected={selected === null}
            onSelect={() => void save({ soundName: null })}
          />
          {sounds.map((sound) => (
            <SoundRow
              key={sound.name}
              label={sound.name}
              selected={selected === sound.name}
              onPreview={() =>
                void playAgentAlertSound(
                  { notificationsEnabled, soundName: sound.name, soundScope: scope },
                  projectId,
                )
              }
              onSelect={() => void save({ soundName: sound.name })}
            />
          ))}
        </div>
        <UploadSoundButton
          projectId={projectId}
          scope={scope}
          onUploaded={async (sound) => {
            await reload();
            await save({ soundName: sound.name });
          }}
        />
      </SettingsCard>
    </div>
  );
}

function SoundRow({
  label,
  selected,
  onPreview,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onPreview?: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 first:pt-0">
      <button
        aria-pressed={selected}
        className={cn(
          "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm transition-colors",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        )}
        type="button"
        onClick={onSelect}
      >
        {label}
      </button>
      {onPreview ? (
        <IconButton
          aria-label={`Play ${label}`}
          label="Play sound"
          size="icon-sm"
          variant="ghost"
          onClick={onPreview}
        >
          <Play />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Lists the clips available in the selected scope's sounds directory. */
function useAgentSounds(
  scope: ConfigScope,
  projectId: string | null,
): { dir: string | null; sounds: AgentSound[]; reload: () => Promise<void> } {
  const [dir, setDir] = useState<string | null>(null);
  const [sounds, setSounds] = useState<AgentSound[]>([]);

  const reload = useCallback(async () => {
    try {
      const listed = await listAgentSounds(scope, projectId);
      setDir(listed.dir);
      setSounds(listed.sounds);
    } catch (cause) {
      setDir(null);
      setSounds([]);
      toast.error(errorMessage(cause));
    }
  }, [projectId, scope]);

  useEffect(() => void reload(), [reload]);
  return { dir, sounds, reload };
}

/**
 * Copies a picked clip into the scope's sounds directory. Duration is checked
 * here because only the webview can decode audio; the host enforces the byte cap.
 */
function UploadSoundButton({
  scope,
  projectId,
  onUploaded,
}: {
  scope: ConfigScope;
  projectId: string | null;
  onUploaded: (sound: AgentSound) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > constants.agentStatus.maxSoundBytes) {
        throw new Error(`${file.name} is larger than the allowed clip size`);
      }
      const seconds = await audioDurationSeconds(bytes.slice(0));
      if (seconds > constants.agentStatus.maxSoundSeconds) {
        throw new Error(
          `${file.name} is ${seconds.toFixed(1)}s; clips must be ${constants.agentStatus.maxSoundSeconds}s or shorter`,
        );
      }
      const sound = await importAgentSound(scope, file.name, encodeBase64(bytes), projectId);
      await onUploaded(sound);
      toast.success(`Added ${sound.name}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <Button
        className="mt-4"
        disabled={uploading}
        variant="outline"
        onClick={() => input.current?.click()}
      >
        <Upload /> Upload clip
      </Button>
      <input
        accept={ACCEPT}
        className="hidden"
        ref={input}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </>
  );
}

/** Decodes just enough of a clip to measure it, so long uploads are rejected. */
async function audioDurationSeconds(bytes: ArrayBuffer): Promise<number> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return 0;
  const context = new AudioContextCtor();
  try {
    const buffer = await context.decodeAudioData(bytes);
    return buffer.duration;
  } catch {
    throw new Error("That file could not be decoded as audio");
  } finally {
    void context.close();
  }
}

function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index] ?? 0);
  }
  return btoa(binary);
}
