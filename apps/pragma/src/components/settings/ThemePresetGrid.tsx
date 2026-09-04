import { Check } from "lucide-react";

import { isThemePreset, THEME_OPTIONS, type ThemePreset } from "@/lib/theme-presets";
import type { ThemeFile } from "@/lib/theme";
import type { ThemeMode } from "@/lib/theme-tokens";
import { cn } from "@/lib/utils";

/**
 * The built-in palette grid: one swatch button per shipped preset, marking the
 * one whose ramps match the current theme file.
 *
 * Shared by Settings → Theme and the first-run onboarding theme step so both
 * offer exactly the same palettes and selection rules.
 */
export function ThemePresetGrid({
  className,
  current,
  defaultIsActive,
  disabled,
  mode,
  onSelect,
}: {
  className?: string;
  /** Theme file the selection is compared against. */
  current: ThemeFile | null;
  /** Whether the shipped default ramp is what is currently in effect. */
  defaultIsActive: boolean;
  disabled: boolean;
  /** Which ramp the swatches preview. */
  mode: ThemeMode;
  onSelect: (preset: ThemePreset) => void;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", className)}>
      {THEME_OPTIONS.map((preset) => {
        const active =
          isThemePreset(current, preset) || (preset.usesThemeDefaults === true && defaultIsActive);
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
            onClick={() => onSelect(preset)}
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
              <span className="block truncate text-xs text-muted-foreground">{preset.source}</span>
            </span>
            {active ? <Check className="size-4 shrink-0 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );
}
