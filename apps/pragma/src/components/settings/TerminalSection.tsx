import { constants, type ShellProfile, type TerminalSettings } from "@pragma/constants";
import { Check, MonitorCog } from "lucide-react";
import { Icon } from "@iconify/react";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { useWslDistros } from "@/hooks/use-wsl-distros";
import { NATIVE_PROFILE, sameProfile, visibleDistros, wslProfile } from "@/lib/shell-profile";
import { cn } from "@/lib/utils";

/**
 * Default-shell settings, stored under `terminal` in the scope's `config.json`.
 *
 * Only a Windows host has a real choice to make here: macOS and Linux always
 * run their own shell, so the picker collapses to an explanation rather than a
 * list of one. The distributions come from the same probe the new-tab menu
 * uses, so both surfaces agree on what is installed.
 *
 * `worktreeId` names the host to probe — the machine whose shells these
 * settings will actually select. It is `null` for global settings, which
 * describe the local host.
 */
export function TerminalSection({
  settings,
  persist,
  worktreeId,
}: {
  settings: TerminalSettings;
  persist: (patch: TerminalSettings) => Promise<void>;
  worktreeId: string | null;
}) {
  const wsl = useWslDistros(worktreeId);
  const distros = visibleDistros(wsl.distros, settings.hiddenDistros);
  // An unset backend means "whatever the platform default is", which today is
  // the native shell everywhere — the same thing the session layer resolves.
  const selected: ShellProfile =
    settings.backend === "wsl" ? wslProfile(settings.distro ?? null) : NATIVE_PROFILE;

  const choose = (profile: ShellProfile) =>
    void persist({ backend: profile.backend, distro: profile.distro ?? null });

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Default shell"
        description="The shell a new terminal tab opens in. The new-tab menu can still launch any of the others for a single tab."
      >
        <div className="divide-y">
          <ShellRow
            label="System default"
            detail={
              wsl.isWindows
                ? "PowerShell 7 when installed, otherwise Windows PowerShell."
                : "The shell named by $SHELL."
            }
            icon={<MonitorCog className="size-4" />}
            selected={sameProfile(selected, NATIVE_PROFILE)}
            onSelect={() => choose(NATIVE_PROFILE)}
          />
          {distros.map((distro) => (
            <ShellRow
              key={distro.name}
              label={distro.name}
              detail={`WSL ${distro.version}${distro.default ? " · WSL default" : ""}${
                distro.running ? " · running" : ""
              }`}
              icon={<Icon className="size-4" icon="simple-icons:linux" />}
              selected={sameProfile(selected, wslProfile(distro.name))}
              onSelect={() => choose(wslProfile(distro.name))}
            />
          ))}
        </div>
        {wsl.isWindows && distros.length === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            No WSL distributions were found. Install one with <code>wsl --install</code> and reopen
            Pragma to pick it here.
          </p>
        ) : null}
        {!wsl.isWindows ? (
          <p className="mt-4 text-xs text-muted-foreground">
            WSL distributions are only available on Windows.
          </p>
        ) : null}
      </SettingsCard>

      {settings.shell ? (
        <SettingsCard
          title="Shell program override"
          description={`This scope pins the native shell to ${settings.shell}. Edit the terminal.shell key of ${constants.plugins.configFileName} to change it.`}
        >
          <p className="text-sm text-muted-foreground">
            The override applies to the system default shell only; a WSL distribution runs whatever
            login shell it is configured with.
          </p>
        </SettingsCard>
      ) : null}
    </div>
  );
}

function ShellRow({
  label,
  detail,
  icon,
  selected,
  onSelect,
}: {
  label: string;
  detail: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 py-3 text-left first:pt-0 last:pb-0",
        selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
    </button>
  );
}
