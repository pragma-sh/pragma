import { useEffect, useId, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EmojiGroup } from "@/lib/emoji-catalog";
import { cn } from "@/lib/utils";

interface EmojiPickerProps {
  /** Currently chosen glyph, highlighted in the grid. */
  value?: string | null;
  /** Called with the glyph the user picked. */
  onSelect: (emoji: string) => void;
  /**
   * Called when the user clears their choice. Omit it and no reset button is
   * rendered; the button is disabled while `value` is already empty.
   */
  onReset?: () => void;
  /** Reset button caption. */
  resetLabel?: string;
  className?: string;
}

/**
 * Search box over a grouped emoji grid. Typing filters on each emoji's name and
 * synonyms; Enter picks the first remaining match so the whole flow is
 * reachable without the mouse.
 *
 * `onReset` adds a reset button under the grid for callers that have a default
 * to fall back to.
 *
 * The search box carries no `autoFocus`: inside a dialog it is the first
 * focusable child, so Radix focuses it on open anyway, and forcing focus would
 * hijack the caret wherever else the picker is embedded.
 *
 * The catalog — every emoji Unicode defines, with its keywords — is a dynamic
 * import so its ~115 KB stays out of the startup bundle; the picker only ever
 * mounts inside a dialog the user opened.
 */
export function EmojiPicker({
  value,
  onSelect,
  onReset,
  resetLabel = "Reset to default",
  className,
}: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<typeof import("@/lib/emoji-catalog") | null>(null);
  const gridId = useId();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const module = await import("@/lib/emoji-catalog");
      if (!cancelled) {
        setCatalog(module);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups: EmojiGroup[] = useMemo(() => catalog?.searchEmoji(query) ?? [], [catalog, query]);
  const firstMatch = groups[0]?.emoji[0];

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Input
        aria-controls={gridId}
        aria-label="Search emoji"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && firstMatch) {
            event.preventDefault();
            onSelect(firstMatch.char);
          }
        }}
        placeholder="Search emoji"
        value={query}
      />
      <div className="h-64 overflow-y-auto" id={gridId}>
        {catalog === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading emoji…</p>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No emoji found</p>
        ) : (
          groups.map((group) => (
            <section key={group.name}>
              <h3 className="bg-popover/95 sticky top-0 py-1 text-xs font-medium text-muted-foreground">
                {group.name}
              </h3>
              <div className="grid grid-cols-8 gap-0.5 pb-2">
                {group.emoji.map((entry) => (
                  <button
                    aria-label={entry.label}
                    aria-pressed={entry.char === value}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-md text-xl leading-none",
                      "transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      entry.char === value && "bg-accent ring-1 ring-ring",
                    )}
                    key={entry.char}
                    onClick={() => onSelect(entry.char)}
                    type="button"
                  >
                    {entry.char}
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {onReset ? (
        <Button
          className="w-full"
          disabled={!value}
          onClick={onReset}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCcw />
          {resetLabel}
        </Button>
      ) : null}
    </div>
  );
}
