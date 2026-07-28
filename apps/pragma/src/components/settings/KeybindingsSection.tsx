import { useCallback, useEffect, useRef, useState } from "react";
import { CircleStop, Radio, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import type { KeybindingChord, KeybindingsConfig } from "@pragma/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { errorMessage } from "@/lib/errors";
import {
  chordFromKeyboardEvent,
  chordsEqual,
  defaultChord,
  formatChord,
  isDefaultChord,
  keybindingActionLabel,
  keybindingActions,
  parseKeybindingOverrides,
  serializeKeybindingOverrides,
  withChordOverride,
  withoutChordOverride,
} from "@/lib/keybinding-editing";
import {
  chordForPlatform,
  KEYBINDINGS_CHANGED_EVENT,
  setRecordingKeybinding,
  type KeybindingAction,
  type KeybindingPlatform,
} from "@/lib/keybindings";
import { isMacPlatform } from "@/lib/platform";
import {
  loadKeybindings,
  readKeybindingsFile,
  setMenuAcceleratorsEnabled,
  writeKeybindingsFile,
  type ConfigScope,
} from "@/lib/tauri";

/**
 * Editable keybindings table. Each row shows the chord that actually applies
 * after the default → global → project merge, so a project row makes it obvious
 * when a global override is already in play. Writes only ever touch the file for
 * the selected scope.
 */
export function KeybindingsSection({
  scope,
  projectId,
}: {
  scope: ConfigScope;
  projectId: string | null;
}) {
  const platform: KeybindingPlatform = isMacPlatform() ? "mac" : "linux";
  const [config, setConfig] = useState<KeybindingsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<KeybindingAction | null>(null);
  const [saving, setSaving] = useState<KeybindingAction | null>(null);

  const load = useCallback(async () => {
    try {
      setConfig(await loadKeybindings(scope === "project" ? projectId : null));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [projectId, scope]);

  useEffect(() => void load(), [load]);

  const write = useCallback(
    async (action: KeybindingAction, chord: KeybindingChord | null) => {
      setSaving(action);
      try {
        const document = await readKeybindingsFile(scope, projectId);
        const overrides = parseKeybindingOverrides(document.contents);
        const next = chord
          ? withChordOverride(overrides, action, platform, chord)
          : withoutChordOverride(overrides, action, platform);
        await writeKeybindingsFile(scope, serializeKeybindingOverrides(next), projectId);
        window.dispatchEvent(new Event(KEYBINDINGS_CHANGED_EVENT));
        await load();
        toast.success(chord ? "Shortcut saved" : "Shortcut reset to default");
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSaving(null);
      }
    },
    [load, platform, projectId, scope],
  );

  const capture = useRecordingCapture({
    action: recording,
    stop: () => setRecording(null),
    onChord: (action, chord) => void write(action, chord),
  });

  if (error) {
    return (
      <SettingsCard title="keybindings.json needs attention">
        <p className="text-sm text-destructive">{error}</p>
        <Button className="mt-4" variant="ghost" onClick={() => void load()}>
          Reload
        </Button>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title="Keyboard shortcuts"
      description={
        scope === "global"
          ? "Recorded shortcuts are saved to ~/.pragma/keybindings.json for every project."
          : "Recorded shortcuts are saved to this project's .pragma/keybindings.json and win over your global ones."
      }
    >
      {config ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Action</th>
              <th className="pb-2 font-medium">Shortcut</th>
              <th className="pb-2 font-medium">Default</th>
              <th className="pb-2 text-right font-medium">Record</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {keybindingActions.map((action) => (
              <KeybindingRow
                action={action}
                config={config}
                key={action}
                platform={platform}
                recording={recording === action}
                saving={saving === action}
                onRecord={() => setRecording(action)}
                onReset={() => void write(action, null)}
                onStop={() => setRecording(null)}
              />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">Loading shortcuts…</p>
      )}
      {recording ? (
        <p aria-live="polite" className="mt-4 text-sm text-muted-foreground">
          Press the shortcut for {keybindingActionLabel(recording)}. Menu shortcuts are paused while
          recording; press Esc or Stop to cancel.
        </p>
      ) : null}
      <span aria-hidden className="sr-only" ref={capture} tabIndex={-1} />
    </SettingsCard>
  );
}

interface KeybindingRowProps {
  action: KeybindingAction;
  config: KeybindingsConfig;
  platform: KeybindingPlatform;
  recording: boolean;
  saving: boolean;
  onRecord: () => void;
  onReset: () => void;
  onStop: () => void;
}

function KeybindingRow({
  action,
  config,
  platform,
  recording,
  saving,
  onRecord,
  onReset,
  onStop,
}: KeybindingRowProps) {
  const label = keybindingActionLabel(action);
  const chord = chordForPlatform(config.bindings[action], platform);
  const changed = !isDefaultChord(action, platform, config);
  return (
    <tr>
      <td className="py-2 pr-4">{label}</td>
      <td className="py-2 pr-4">
        {recording ? (
          <span className="text-xs text-primary">Listening…</span>
        ) : (
          <Kbd>{formatChord(chord, platform)}</Kbd>
        )}
      </td>
      <td className="py-2 pr-4 text-xs text-muted-foreground">
        {changed
          ? `Changed from ${formatChord(defaultChord(action, platform), platform)}`
          : "Default"}
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {changed ? (
          <Button
            aria-label={`Reset ${label} to default`}
            disabled={saving}
            size="icon-sm"
            variant="ghost"
            onClick={onReset}
          >
            <RotateCcw />
          </Button>
        ) : null}
        {recording ? (
          <Button size="sm" variant="secondary" onClick={onStop}>
            <CircleStop /> Stop
          </Button>
        ) : (
          <Button disabled={saving} size="sm" variant="ghost" onClick={onRecord}>
            <Radio /> Record
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * Captures the next chord while recording. Shortcut handlers are muted and the
 * native menu accelerators are suspended, so chords the app already owns (Cmd+T,
 * Cmd+W) can be recorded instead of firing their action.
 */
function useRecordingCapture({
  action,
  stop,
  onChord,
}: {
  action: KeybindingAction | null;
  stop: () => void;
  onChord: (action: KeybindingAction, chord: KeybindingChord) => void;
}): (node: HTMLElement | null) => void {
  const anchor = useRef<HTMLElement | null>(null);
  const handlers = useRef({ stop, onChord });
  handlers.current = { stop, onChord };

  useEffect(() => {
    if (!action) return;
    const target = action;
    setRecordingKeybinding(true);
    void setMenuAcceleratorsEnabled(false).catch(() => undefined);
    anchor.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      const chord = chordFromKeyboardEvent(event);
      if (!chord) return;
      if (chordsEqual(chord, { modifiers: [], key: "escape" })) {
        handlers.current.stop();
        return;
      }
      handlers.current.onChord(target, chord);
      handlers.current.stop();
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setRecordingKeybinding(false);
      void setMenuAcceleratorsEnabled(true).catch(() => undefined);
    };
  }, [action]);

  return useCallback((node: HTMLElement | null) => {
    anchor.current = node;
  }, []);
}
