import {
  constants,
  type ShellProfile,
  type TerminalSettings,
  type WslDistro,
} from "@pragma-sh/constants";

import type { ShellQuoteStyle } from "@/lib/terminal-drop";
import { readConfig } from "@/lib/tauri";

/** The host's own shell — PowerShell on Windows, `$SHELL` on macOS/Linux. */
export const NATIVE_PROFILE: ShellProfile = { backend: "native", distro: null };

/**
 * Reads the `terminal` block of one config scope.
 *
 * A missing, unreadable, or malformed file yields `undefined` rather than
 * throwing: a broken config must not stop a shell decision from resolving,
 * the same tolerance the server applies when it resolves the shell.
 */
async function readTerminalScope(
  scope: "global" | "project",
  projectId?: string | null,
): Promise<TerminalSettings | undefined> {
  try {
    const document = await readConfig(scope, projectId);
    if (!document?.exists) return undefined;
    const parsed: unknown = JSON.parse(document.contents);
    if (!parsed || typeof parsed !== "object") return undefined;
    const terminal = (parsed as { terminal?: unknown }).terminal;
    return terminal && typeof terminal === "object" ? (terminal as TerminalSettings) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads both Settings scopes' `terminal` blocks, project first. */
export function loadTerminalScopes(
  projectId: string | null,
): Promise<readonly (TerminalSettings | undefined)[]> {
  return Promise.all([
    projectId ? readTerminalScope("project", projectId) : Promise.resolve(undefined),
    readTerminalScope("global"),
  ]);
}

/** The configured native shell program across Settings scopes, project first. */
export function resolveConfiguredShell(
  scopes: readonly (TerminalSettings | undefined)[],
): string | undefined {
  return scopes.find((scope) => scope?.shell)?.shell;
}

// Windows program stems that name PowerShell, in either edition — mirrors
// `pragma_platform::shell::is_powershell`.
const POWERSHELL_STEMS = new Set(["pwsh", "powershell", "pwsh-preview"]);

/**
 * Lowercased file stem of a program path, so `C:\...\pwsh.exe` reads as
 * `pwsh` regardless of which separator the value uses — mirrors
 * `pragma_platform::shell::stem`.
 */
function shellStem(program: string): string {
  const fileName = program.split(/[/\\]/).pop() ?? program;
  return fileName.replace(/\.[^./\\]+$/, "").toLowerCase();
}

/**
 * The quoting a dropped path needs for the native Windows shell actually
 * configured. `terminal.shell` can name `cmd.exe`, not just PowerShell — see
 * `ShellQuoteStyle`. An unconfigured shell falls back to PowerShell, the
 * platform default (`platform.shells.windows`); any other native shell
 * (Git Bash, `nu.exe`, …) gets POSIX-style quoting.
 */
export function nativeShellQuoteStyle(shellProgram: string | undefined): ShellQuoteStyle {
  const stem = shellProgram ? shellStem(shellProgram) : undefined;
  if (stem === "cmd") return "cmd";
  if (!stem || POWERSHELL_STEMS.has(stem)) return "powershell";
  return "posix";
}

/** A WSL profile for one distribution. `null` means WSL's own default distro. */
export function wslProfile(distro: string | null): ShellProfile {
  return { backend: "wsl", distro };
}

/**
 * Whether two profiles name the same shell. Distinguishes "no distro" (WSL's
 * own default) from a distro that happens to be WSL's default today, because
 * the user picked one of them deliberately.
 */
export function sameProfile(a: ShellProfile | null, b: ShellProfile | null): boolean {
  if (!a || !b) return a === b;
  return a.backend === b.backend && (a.distro ?? null) === (b.distro ?? null);
}

/**
 * Distributions offered in the shell picker.
 *
 * A project's `hiddenDistros` replaces the shipped list rather than merging
 * with it, so a user who wants Docker's VM distros back can ask for them by
 * configuring an empty list.
 */
export function visibleDistros(
  distros: readonly WslDistro[],
  hidden: readonly string[] | undefined,
): WslDistro[] {
  const hiddenNames = new Set(
    (hidden ?? constants.terminalDefaults.hiddenDistros).map((name) => name.toLowerCase()),
  );
  return distros.filter((distro) => !hiddenNames.has(distro.name.toLowerCase()));
}

/**
 * The profile a plain new tab opens with, given one scope's terminal settings.
 * Returns `null` when nothing is configured, which leaves the choice to the
 * server — the same path a tab took before shell selection existed.
 */
export function defaultProfile(terminal: TerminalSettings | undefined): ShellProfile | null {
  if (!terminal?.backend) return null;
  return terminal.backend === "wsl" ? wslProfile(terminal.distro ?? null) : NATIVE_PROFILE;
}

/**
 * The configured default across Settings scopes, project first.
 *
 * `backend` and `distro` are taken from the *same* scope rather than merged
 * field by field: a project that switches to `native` must not inherit the
 * global scope's stale `distro`. This mirrors the server's own resolution
 * (`configured_profile` in `crates/pragma-server/src/session.rs`), so the badge
 * the menu draws names the shell the session layer will actually launch.
 */
export function resolveDefaultProfile(
  scopes: readonly (TerminalSettings | undefined)[],
): ShellProfile | null {
  for (const scope of scopes) {
    const profile = defaultProfile(scope);
    if (profile) return profile;
  }
  return null;
}

/**
 * Names the distribution behind a bare "use WSL's default" configuration.
 *
 * A profile of `{ backend: "wsl", distro: null }` launches whatever WSL calls
 * its default, which is a real distribution in the list — without resolving it
 * to that name, a picker comparing profiles would match no entry at all and
 * show no default. Left untouched when the configuration already names one, or
 * when WSL reports no default.
 */
export function effectiveDefaultProfile(
  configured: ShellProfile,
  distros: readonly WslDistro[],
): ShellProfile {
  if (configured.backend !== "wsl" || configured.distro) return configured;
  const wslDefault = distros.find((distro) => distro.default);
  return wslDefault ? wslProfile(wslDefault.name) : configured;
}

/** The first scope that hides distributions, if any. */
export function resolveHiddenDistros(
  scopes: readonly (TerminalSettings | undefined)[],
): string[] | undefined {
  return scopes.find((scope) => scope?.hiddenDistros)?.hiddenDistros;
}

/** Human-readable name for a profile, used in menus and settings. */
export function profileLabel(profile: ShellProfile | null): string {
  if (!profile || profile.backend === "native") return "Terminal";
  return profile.distro ?? "WSL (default)";
}
