import { Check, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isMacPlatform } from "@/lib/platform";

/** The ⌘/Ctrl label for the current platform. */
function modKey(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

interface InlineEditHunkBarProps {
  /** 1-based position of this hunk among the ones still unresolved. */
  index: number;
  total: number;
  /** True when the keyboard shortcuts act on this hunk. */
  focused: boolean;
  /** The model's summary — only shown on the first bar, as a caption. */
  summary: string;
  onResolve: (decision: "accept" | "reject") => void;
  onResolveAll: (decision: "accept" | "reject") => void;
}

/**
 * The control bar drawn directly above one diff hunk: what changed, which hunk
 * this is, and accept/reject for it or for the whole edit.
 *
 * The buttons mirror the keyboard scheme rather than replacing it — the focused
 * hunk shows its shortcuts so the keys are discoverable without a menu.
 */
export function InlineEditHunkBar({
  index,
  total,
  focused,
  summary,
  onResolve,
  onResolveAll,
}: InlineEditHunkBarProps) {
  return (
    <div
      className={`my-1 flex flex-wrap items-center gap-2 rounded-lg border bg-popover px-2 py-1 font-sans text-popover-foreground shadow-sm ${
        focused ? "border-ring" : "border-border"
      }`}
    >
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {index === 1 && summary ? summary : `Change ${index} of ${total}`}
      </span>
      {focused ? (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Kbd>{`${modKey()}↵`}</Kbd>
          <Kbd>{`${modKey()}⌫`}</Kbd>
          <Kbd>⌥↑↓</Kbd>
        </span>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          aria-label={`Accept change ${index}`}
          className="h-6 gap-1 px-2 text-xs"
          size="sm"
          variant="ghost"
          onClick={() => onResolve("accept")}
        >
          <Check className="size-3.5" /> Accept
        </Button>
        <Button
          aria-label={`Reject change ${index}`}
          className="h-6 gap-1 px-2 text-xs"
          size="sm"
          variant="ghost"
          onClick={() => onResolve("reject")}
        >
          <X className="size-3.5" /> Reject
        </Button>
        {total > 1 ? (
          <>
            <Button
              aria-label="Accept all changes"
              className="h-6 px-2 text-xs text-muted-foreground"
              size="sm"
              variant="ghost"
              onClick={() => onResolveAll("accept")}
            >
              Accept all
            </Button>
            <Button
              aria-label="Reject all changes"
              className="h-6 px-2 text-xs text-muted-foreground"
              size="sm"
              variant="ghost"
              onClick={() => onResolveAll("reject")}
            >
              Reject all
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
