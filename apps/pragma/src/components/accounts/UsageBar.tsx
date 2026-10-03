import type { ProviderView } from "@/lib/accounts";
import { usageToneClass } from "@/lib/usage-limits";
import { cn } from "@/lib/utils";

/** A thin horizontal usage bar; an unknown percentage renders an empty track. */
export function UsageBar({ percent, className }: { percent: number | null; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}>
      {percent === null ? null : (
        <div
          className={cn("h-full rounded-full", usageToneClass(percent))}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      )}
    </div>
  );
}

/**
 * The toolbar trigger's glyph: one vertical micro-bar per provider, each filled
 * to that provider's worst in-use account.
 */
export function ProviderMicroBars({ providers }: { providers: ProviderView[] }) {
  const shown = providers.slice(0, 6);
  if (shown.length === 0) {
    return <span className="block h-3.5 w-1 rounded-sm bg-muted" />;
  }
  return (
    <span aria-hidden className="flex h-3.5 items-end gap-0.5">
      {shown.map((provider) => (
        <span
          className="relative block h-full w-1 overflow-hidden rounded-sm bg-muted"
          key={provider.provider}
        >
          {provider.worstPercent === null ? null : (
            <span
              className={cn(
                "absolute inset-x-0 bottom-0 block rounded-sm",
                usageToneClass(provider.worstPercent),
              )}
              style={{ height: `${Math.max(12, provider.worstPercent)}%` }}
            />
          )}
        </span>
      ))}
    </span>
  );
}
