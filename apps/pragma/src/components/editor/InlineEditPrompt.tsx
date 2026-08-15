import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Plus, Square } from "lucide-react";

import { IconTooltip } from "@/components/ui/icon-button";
import type { InlineEditPhase } from "@/components/editor/inline-edit-extension";
import { cn } from "@/lib/utils";

interface InlineEditPromptProps {
  phase: InlineEditPhase;
  /** Failure text from the model or the sidecar. */
  error: string;
  onSubmit: (instruction: string) => void;
  /** Stops an in-flight request and returns to the editable prompt. */
  onAbort: () => void;
  /** Closes the session (Esc). */
  onCancel: () => void;
}

/**
 * The prompt that opens under the highlighted lines — styled like the browser
 * design-mode pill: a rounded input with a circular action button.
 *
 * Enter submits, Escape closes. While the model is working the input pulses
 * and the action button becomes Abort.
 */
export function InlineEditPrompt({
  phase,
  error,
  onSubmit,
  onAbort,
  onCancel,
}: InlineEditPromptProps) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const running = phase === "running";

  useEffect(() => {
    if (!running) {
      inputRef.current?.focus();
    }
  }, [running]);

  const submit = () => {
    if (instruction.trim() && !running) {
      onSubmit(instruction.trim());
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (running) {
        return;
      }
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="my-1 font-sans">
      <div
        className={cn(
          "flex max-w-md items-center gap-1.5 rounded-full border border-border bg-popover py-1.5 pr-1.5 pl-3.5 text-popover-foreground shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
          running && "animate-pulse",
        )}
      >
        <input
          aria-busy={running}
          aria-label="Describe the edit"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-default"
          disabled={running}
          placeholder="Describe the edit"
          ref={inputRef}
          type="text"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <IconTooltip label="Abort edit">
            <button
              aria-label="Abort edit"
              className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary-hover"
              type="button"
              onClick={onAbort}
            >
              <Square className="size-3 fill-current" />
            </button>
          </IconTooltip>
        ) : (
          <IconTooltip label="Submit edit">
            <button
              aria-label="Submit edit"
              className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              disabled={!instruction.trim()}
              type="button"
              onClick={submit}
            >
              <Plus className="size-4 stroke-[2.5]" />
            </button>
          </IconTooltip>
        )}
      </div>
      {error ? <p className="pt-1.5 pl-3.5 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
