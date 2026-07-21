import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { cn } from "@/lib/utils";

export interface FindReplaceReplaceProps {
  value: string;
  onValueChange: (value: string) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  /** Disables both replace actions, e.g. no match to replace. */
  replaceDisabled?: boolean;
}

export interface FindReplaceBarProps {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  ignoreCase: boolean;
  onIgnoreCaseChange: (value: boolean) => void;
  /** 0 when there are no matches. */
  matchCount: number;
  /** 1-indexed; 0 when there are no matches. */
  currentMatch: number;
  onNext: () => void;
  onPrevious: () => void;
  /** Omit to render a find-only bar (e.g. the browser view). */
  replace?: FindReplaceReplaceProps;
  findPlaceholder?: string;
  className?: string;
}

/**
 * Floating find/replace bar anchored to a pane's top-right corner. Find is
 * always visible; replace (when provided) lives behind a collapsible chevron
 * so the default state stays minimal. Native browser webviews paint above all
 * HTML, so this always registers a suppression while open — a harmless no-op
 * for the editor/terminal panes.
 */
// fallow-ignore-next-line complexity -- single floating bar rendering find controls plus an optional collapsible replace section; the branching is the UI, not accidental complexity.
export function FindReplaceBar({
  open,
  onClose,
  query,
  onQueryChange,
  ignoreCase,
  onIgnoreCaseChange,
  matchCount,
  currentMatch,
  onNext,
  onPrevious,
  replace,
  findPlaceholder = "Find",
  className,
}: FindReplaceBarProps) {
  const [replaceOpen, setReplaceOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const ignoreCaseId = useId();

  useSuppressNativeOverlayWhile(open);

  useEffect(() => {
    if (open) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const handleFindKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onPrevious();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onNext();
    }
  };

  const handleReplaceKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && replace) {
      event.preventDefault();
      replace.onReplace();
    }
  };

  return (
    <div
      className={cn(
        "absolute top-2 right-2 z-20 flex w-72 flex-col gap-1.5 rounded-lg bg-popover p-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        {replace ? (
          <Button
            aria-label={replaceOpen ? "Hide replace" : "Show replace"}
            className="shrink-0"
            onClick={() => setReplaceOpen((value) => !value)}
            size="icon-sm"
            variant="ghost"
          >
            {replaceOpen ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ) : null}
        <Input
          className="h-7"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleFindKeyDown}
          placeholder={findPlaceholder}
          ref={findInputRef}
          value={query}
        />
        <span className="w-12 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
          {matchCount > 0 ? `${currentMatch}/${matchCount}` : query ? "0/0" : ""}
        </span>
        <Button
          aria-label="Previous match"
          className="shrink-0"
          disabled={matchCount === 0}
          onClick={onPrevious}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
        <Button
          aria-label="Next match"
          className="shrink-0"
          disabled={matchCount === 0}
          onClick={onNext}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
        <Button
          aria-label="Close find"
          className="shrink-0"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
      {replace ? (
        <Collapsible onOpenChange={setReplaceOpen} open={replaceOpen}>
          <CollapsibleContent className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1 pl-7">
              <Input
                className="h-7"
                onChange={(event) => replace.onValueChange(event.target.value)}
                onKeyDown={handleReplaceKeyDown}
                placeholder="Replace"
                value={replace.value}
              />
              <Button
                className="shrink-0"
                disabled={replace.replaceDisabled}
                onClick={replace.onReplace}
                size="sm"
                variant="outline"
              >
                Replace
              </Button>
              <Button
                className="shrink-0"
                disabled={replace.replaceDisabled}
                onClick={replace.onReplaceAll}
                size="sm"
                variant="outline"
              >
                All
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <label
        className="flex items-center gap-1.5 pl-7 text-xs text-muted-foreground"
        htmlFor={ignoreCaseId}
      >
        <Checkbox
          checked={ignoreCase}
          id={ignoreCaseId}
          onCheckedChange={(checked) => onIgnoreCaseChange(checked === true)}
        />
        Ignore case
      </label>
    </div>
  );
}
