import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import type { ThemeDefinition } from "@pragma/plugin";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from "@/components/ui/color-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/errors";
import { writeTheme, type ConfigScope } from "@/lib/tauri";
import {
  resolveThemeToken,
  serializeThemeFile,
  THEME_CHANGED_EVENT,
  THEME_FILE_NAME,
  withThemeOverride,
  type ThemeFile,
} from "@/lib/theme";
import { cssColorToRgbaString, rgbaToOklch, type Rgba } from "@/lib/theme-color";
import {
  isThemePreset,
  THEME_OPTIONS,
  withThemePreset,
  type ThemePreset,
} from "@/lib/theme-presets";
import {
  THEME_TOKEN_GROUPS,
  themeTokenLabel,
  type ThemeMode,
  type ThemeTokenGroup,
} from "@/lib/theme-tokens";
import { cn } from "@/lib/utils";
import { collectContributions, useActivePlugins } from "@/plugins/registry";
import { useTheme } from "@/state/theme-context";

/** Where a token's current value comes from, which is what the row badge reports. */
type TokenOrigin = "default" | "global" | "custom";

interface TokenState {
  value: string;
  origin: TokenOrigin;
}

const ORIGIN_LABEL: Record<TokenOrigin, string> = {
  default: "Default",
  global: "From global",
  custom: "Custom",
};

/**
 * Previews a color scheme by flipping the document's `dark` class while the
 * Theme page has that mode selected — the app itself ships dark-only, so this is
 * the only way to see light tokens land. The macOS `vibrancy` class comes off
 * with it: its translucency rules are authored for the dark ramp.
 */
function useModePreview(mode: ThemeMode): void {
  useEffect(() => {
    if (mode === "dark") return;
    const root = document.documentElement;
    const hadVibrancy = root.classList.contains("vibrancy");
    root.classList.remove("dark");
    root.classList.remove("vibrancy");
    return () => {
      root.classList.add("dark");
      if (hadVibrancy) root.classList.add("vibrancy");
    };
  }, [mode]);
}

function tokenState(
  mode: ThemeMode,
  token: string,
  scope: ConfigScope,
  global: ThemeFile | null,
  project: ThemeFile | null,
): TokenState {
  const scoped = (scope === "global" ? global : project)?.colors?.[mode]?.[token];
  if (scoped) return { value: scoped, origin: "custom" };
  const inherited = scope === "project" ? global?.colors?.[mode]?.[token] : undefined;
  if (inherited) return { value: inherited, origin: "global" };
  return { value: resolveThemeToken(mode, token, {}), origin: "default" };
}

/**
 * Editor for `.pragma/theme.json` at the selected scope. Rows show the resolved
 * color, where it came from, and offer a reset plus a color-picker popover;
 * every change writes the file and re-applies the merged theme immediately.
 */
export function ThemeSection({
  scope,
  projectId,
}: {
  scope: ConfigScope;
  projectId: string | null;
}) {
  const theme = useTheme();
  const pluginThemes = collectContributions(
    useActivePlugins(scope === "project" ? projectId : null),
    (definition) => definition.themes,
  );
  const [mode, setMode] = useState<ThemeMode>("dark");
  const [saving, setSaving] = useState(false);
  useModePreview(mode);

  const scopeError = theme.errors[scope];
  const current = scope === "global" ? theme.global : theme.project;

  const setToken = useCallback(
    async (token: string, value: string | null) => {
      const currentFile = scope === "global" ? theme.global : theme.project;
      const next = withThemeOverride(currentFile, mode, token, value);
      setSaving(true);
      try {
        await writeTheme(scope, serializeThemeFile(next), projectId);
        window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [mode, projectId, scope, theme.global, theme.project],
  );

  const applyPreset = useCallback(
    async (preset: ThemePreset) => {
      const next = withThemePreset(current, preset);
      setSaving(true);
      try {
        await writeTheme(scope, serializeThemeFile(next), projectId);
        window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [current, projectId, scope],
  );

  const applyPluginTheme = useCallback(
    async (pluginTheme: ThemeDefinition) => {
      const next: ThemeFile = {
        ...current,
        colors: {
          light: { ...pluginTheme.colors.light },
          dark: { ...pluginTheme.colors.dark },
        },
      };
      setSaving(true);
      try {
        await writeTheme(scope, serializeThemeFile(next), projectId);
        window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [current, projectId, scope],
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">Theme</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {scope === "global"
                ? "Color overrides for every project."
                : "Color overrides for this project only — they win over the global theme and apply the moment you switch to it."}
            </p>
          </div>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <p className="mt-4 font-mono text-xs text-muted-foreground">{THEME_FILE_NAME}</p>
        {scopeError ? <p className="mt-2 text-sm text-destructive">{scopeError}</p> : null}
      </section>

      <ThemePresets
        current={current}
        defaultIsActive={
          !current?.colors && !(scope === "project" && Boolean(theme.global?.colors))
        }
        disabled={saving}
        mode={mode}
        onSelect={applyPreset}
      />

      {pluginThemes.length > 0 ? (
        <PluginThemes
          current={current}
          disabled={saving}
          mode={mode}
          themes={pluginThemes}
          onSelect={applyPluginTheme}
        />
      ) : null}

      {THEME_TOKEN_GROUPS.map((group) => (
        <ThemeGroup
          key={group.id}
          disabled={saving}
          global={theme.global}
          group={group}
          mode={mode}
          project={theme.project}
          scope={scope}
          setToken={setToken}
        />
      ))}
    </div>
  );
}

function PluginThemes({
  current,
  disabled,
  mode,
  onSelect,
  themes,
}: {
  current: ThemeFile | null;
  disabled: boolean;
  mode: ThemeMode;
  onSelect: (theme: ThemeDefinition) => Promise<void>;
  themes: ReturnType<typeof collectContributions<ThemeDefinition>>;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="font-semibold">Plugin themes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Palettes supplied by active plugins. Applying one copies its colors into this scope.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {themes.map(({ contribution, pluginId }) => {
          const active = JSON.stringify(current?.colors) === JSON.stringify(contribution.colors);
          const colors = contribution.colors[mode];
          return (
            <button
              key={`${pluginId}:${contribution.id}`}
              className={cn(
                "group flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent",
                active && "border-primary ring-1 ring-primary",
              )}
              disabled={disabled}
              title={contribution.description}
              type="button"
              onClick={() => void onSelect(contribution)}
            >
              <span className="flex shrink-0 -space-x-1.5" aria-hidden>
                <span
                  className="size-6 rounded-full border-2 border-background"
                  style={{ backgroundColor: colors.primary ?? colors.foreground }}
                />
                <span
                  className="size-6 rounded-full border-2 border-background"
                  style={{ backgroundColor: colors.secondary ?? colors.background }}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{contribution.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{pluginId}</span>
              </span>
              {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ThemePresets({
  current,
  defaultIsActive,
  disabled,
  mode,
  onSelect,
}: {
  current: ThemeFile | null;
  defaultIsActive: boolean;
  disabled: boolean;
  mode: ThemeMode;
  onSelect: (preset: ThemePreset) => Promise<void>;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="font-semibold">Built-in themes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Published coding and developer-brand palettes. Applying one writes complete light and dark
        ramps to this scope.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {THEME_OPTIONS.map((preset) => {
          const active =
            isThemePreset(current, preset) ||
            (preset.usesThemeDefaults === true && defaultIsActive);
          const colors = preset[mode];
          return (
            <button
              key={preset.id}
              className={cn(
                "group flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent",
                active && "border-primary ring-1 ring-primary",
              )}
              disabled={disabled}
              title={`${preset.source} · ${preset.sourceUrl}`}
              type="button"
              onClick={() => void onSelect(preset)}
            >
              <span className="flex shrink-0 -space-x-1.5" aria-hidden>
                <span
                  className="size-6 rounded-full border-2 border-background"
                  style={{ backgroundColor: colors.primary }}
                />
                <span
                  className="size-6 rounded-full border-2 border-background"
                  style={{ backgroundColor: colors.secondary }}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{preset.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {preset.source}
                </span>
              </span>
              {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ModeToggle({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  return (
    <div className="flex rounded-lg border bg-background p-0.5" aria-label="Color scheme">
      <Button
        size="sm"
        variant={mode === "dark" ? "secondary" : "ghost"}
        onClick={() => onChange("dark")}
      >
        Dark
      </Button>
      <Button
        size="sm"
        variant={mode === "light" ? "secondary" : "ghost"}
        onClick={() => onChange("light")}
      >
        Light
      </Button>
    </div>
  );
}

function ThemeGroup({
  disabled,
  global,
  group,
  mode,
  project,
  scope,
  setToken,
}: {
  disabled: boolean;
  global: ThemeFile | null;
  group: ThemeTokenGroup;
  mode: ThemeMode;
  project: ThemeFile | null;
  scope: ConfigScope;
  setToken: (token: string, value: string | null) => Promise<void>;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="font-semibold">{group.label}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
      <ul className="mt-4 divide-y">
        {group.tokens.map((token) => (
          <ThemeTokenRow
            key={token}
            disabled={disabled}
            mode={mode}
            state={tokenState(mode, token, scope, global, project)}
            token={token}
            setToken={setToken}
          />
        ))}
      </ul>
    </section>
  );
}

function ThemeTokenRow({
  disabled,
  mode,
  setToken,
  state,
  token,
}: {
  disabled: boolean;
  mode: ThemeMode;
  setToken: (token: string, value: string | null) => Promise<void>;
  state: TokenState;
  token: string;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <ColorSwatch value={state.value} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{themeTokenLabel(token)}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          --{token} · {state.value}
        </p>
      </div>
      <span
        className={cn(
          "rounded-md px-2 py-0.5 text-xs",
          state.origin === "custom" ? "bg-primary/15 text-primary" : "text-muted-foreground",
        )}
      >
        {ORIGIN_LABEL[state.origin]}
      </span>
      <IconButton
        aria-label={`Reset ${themeTokenLabel(token)}`}
        disabled={disabled || state.origin !== "custom"}
        label="Reset color"
        size="icon-sm"
        variant="ghost"
        onClick={() => void setToken(token, null)}
      >
        <RotateCcw />
      </IconButton>
      <ThemeColorPopover
        disabled={disabled}
        mode={mode}
        token={token}
        value={state.value}
        onPick={(value) => void setToken(token, value)}
      />
    </li>
  );
}

function ColorSwatch({ value }: { value: string }) {
  return (
    <span
      aria-hidden
      className="size-7 shrink-0 rounded-md border bg-[image:repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:10px_10px]"
    >
      <span className="block size-full rounded-[5px]" style={{ backgroundColor: value }} />
    </span>
  );
}

function ThemeColorPopover({
  disabled,
  mode,
  onPick,
  token,
  value,
}: {
  disabled: boolean;
  mode: ThemeMode;
  onPick: (value: string) => void;
  token: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const seed = cssColorToRgbaString(value) ?? "#000000";

  const onChange = useCallback((rgba: Rgba) => setPending(rgbaToOklch(rgba)), []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setPending(null);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton
          aria-label={`Edit ${themeTokenLabel(token)}`}
          disabled={disabled}
          label="Edit color"
          size="icon-sm"
          variant="ghost"
        >
          <Pencil />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="font-mono text-xs text-muted-foreground">
          --{token} · {mode}
        </p>
        {/* Remounted per popover session so the picker seeds from the live value. */}
        <ColorPicker key={seed} className="h-auto w-full" defaultValue={seed} onChange={onChange}>
          <ColorPickerSelection className="h-32 rounded-lg" />
          <ColorPickerHue />
          <ColorPickerAlpha />
          <div className="flex items-center gap-2">
            <ColorPickerEyeDropper />
            <ColorPickerOutput />
            <ColorPickerFormat />
          </div>
        </ColorPicker>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!pending}
            size="sm"
            onClick={() => {
              if (pending) onPick(pending);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
