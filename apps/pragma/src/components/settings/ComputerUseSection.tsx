import { useCallback } from "react";

import type { ComputerAccess, ComputerUseSettings } from "@pragma-sh/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { ComputerPermissionControls } from "@/components/computer-use/ComputerPermissionControls";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useComputerPermissions } from "@/hooks/use-computer-permissions";
import { isMacPlatform } from "@/lib/platform";
import { controlSession, useComputerUse } from "@/state/computer-use-store";

const ACCESS_LABELS: Record<ComputerAccess, string> = {
  ask: "Ask me first",
  allow: "Allow",
  deny: "Never",
};

/** The emergency-stop chord `src-tauri/src/computer.rs` registers, for display. */
const STOP_CHORD = isMacPlatform() ? ["⌃", "⌥", "⌘", "."] : ["Ctrl", "Alt", "Shift", "Esc"];

/**
 * Settings → Computer Use: the global `computerUse` block of `config.json`.
 *
 * Off by default. When on, agents, plugins, and scripts may read and control
 * desktop apps through `pragma-cli computer` and `client.computer`, subject to
 * the access policy here, the approval prompts, and the emergency stop.
 */
export function ComputerUseSection({
  settings,
  persist,
}: {
  settings: ComputerUseSettings;
  persist: (patch: ComputerUseSettings) => Promise<void>;
}) {
  const enabled = settings.enabled === true;
  const access = settings.access ?? {};
  const { snapshot } = useComputerUse();

  const save = useCallback(
    async (patch: ComputerUseSettings) => {
      try {
        await persist(patch);
      } catch {
        // `persist` already surfaced the failure and reloaded the config.
      }
    },
    [persist],
  );

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Computer use"
        description="Let agents read the screen and click and type in other apps on this computer. You always see what they do, and you can stop them at any time."
        actions={
          <Switch
            aria-label="Enable computer use"
            checked={enabled}
            onCheckedChange={(checked) => void save({ enabled: checked })}
          />
        }
      >
        {snapshot?.stopped ? (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <span>Computer use is stopped. Agents cannot act until you resume it.</span>
            <Button onClick={() => void controlSession("unpause")} size="sm">
              Resume
            </Button>
          </div>
        ) : null}
      </SettingsCard>

      <PermissionsCard />

      <SettingsCard
        title="Who may control apps"
        description="“Ask me first” shows a prompt the first time each agent tries. Pragma itself, password managers, and security prompts are always off limits."
      >
        <div className="mt-4 divide-y">
          <AccessRow
            label="Agents"
            onChange={(value) =>
              void save({ access: { ...access, agents: { ...access.agents, "*": value } } })
            }
            value={access.agents?.["*"] ?? "ask"}
          />
          <AccessRow
            label="Scripts and the SDK"
            onChange={(value) => void save({ access: { ...access, sdk: value } })}
            value={access.sdk ?? "ask"}
          />
          <AccessRow
            description="Buttons like Delete, Send, or Pay, and password fields."
            label="Sensitive controls"
            onChange={(value) => void save({ access: { ...access, sensitive: value } })}
            value={access.sensitive ?? "ask"}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Seeing and stopping"
        description="While an agent is in control, its cursor is drawn on screen and a small panel in Pragma shows what it is doing."
      >
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <label className="text-sm" htmlFor="computer-use-cursor">
              Show the agent cursor
            </label>
            <Switch
              checked={settings.showCursor !== false}
              id="computer-use-cursor"
              onCheckedChange={(checked) => void save({ showCursor: checked })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>Stop everything, from any app</span>
            <span className="flex gap-1">
              {STOP_CHORD.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

function AccessRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: ComputerAccess;
  onChange: (value: ComputerAccess) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="text-sm">
        {label}
        {description ? (
          <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </div>
      <Select onValueChange={(next) => onChange(next as ComputerAccess)} value={value}>
        <SelectTrigger aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ACCESS_LABELS) as ComputerAccess[]).map((option) => (
            <SelectItem key={option} value={option}>
              {ACCESS_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The helper's macOS permissions, with separate buttons for the OS prompts. */
function PermissionsCard() {
  const { permissions, error, requesting, load } = useComputerPermissions();

  if (permissions && !permissions.supported) {
    return (
      <SettingsCard
        title="Permissions"
        description={`Computer use is not available on ${permissions.platform} yet.`}
      />
    );
  }
  if (permissions?.platform === "windows") {
    return (
      <SettingsCard
        title="Permissions"
        description="Windows allows control of ordinary desktop apps. Elevated apps and the secure desktop are off limits. Keyboard and pointer input may bring the target app to the front."
      />
    );
  }
  return (
    <SettingsCard
      title="Permissions"
      description="macOS asks once for each. They belong to Pragma's computer-use helper."
    >
      <div className="mt-4">
        {permissions ? (
          <ComputerPermissionControls
            permissions={permissions}
            requesting={requesting}
            request={load}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Checking permissions…</p>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
