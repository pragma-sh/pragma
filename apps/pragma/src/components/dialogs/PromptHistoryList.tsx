import { Split } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  promptHistoryLabel,
  promptHistorySummary,
  type PromptHistoryEntry,
} from "@/lib/worktree-prompt-history";

/**
 * The create dialog's history view: every run previously submitted from it,
 * newest first. Picking one hands it back so the form can be filled from it.
 */
export function PromptHistoryList({
  entries,
  onPick,
  onBack,
}: {
  entries: PromptHistoryEntry[];
  onPick: (entry: PromptHistoryEntry) => void;
  onBack: () => void;
}) {
  return (
    <div className="mt-5 space-y-4">
      {entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No submitted prompts yet. Prompts you submit from this dialog show up here.
        </p>
      ) : null}
      <ul aria-label="Submitted prompts" className="max-h-96 space-y-1 overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              className="w-full rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              type="button"
              onClick={() => onPick(entry)}
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{promptHistoryLabel(entry)}</span>
                {entry.mode === "fanout" ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Split className="size-3" />
                    {entry.agents.length} attempts
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {new Date(entry.submittedAt).toLocaleDateString()}
                </span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {promptHistorySummary(entry)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
