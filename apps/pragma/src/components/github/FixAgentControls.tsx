import { useId } from "react";

import { ChevronRight } from "lucide-react";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FixLauncher } from "@/hooks/use-fix-launcher";

/**
 * The agent picker plus the collapsible "create a new worktree to fix on" section
 * (branch + display title, same fields as the New-worktree dialog), shared by the
 * single-comment and fix-it-list dialogs. Purely presentational — all state lives
 * in the `FixLauncher`.
 */
export function FixAgentControls({ launcher }: { launcher: FixLauncher }) {
  const { selection, newWorktree, setNewWorktreeEnabled, setBranch, setTitle } = launcher;
  const branchId = useId();
  const titleId = useId();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Agent</Label>
        <AgentModelSelector
          agents={selection.agents}
          modelsByAgent={selection.modelsByAgent}
          onChange={selection.handleAgentChange}
          onLoadModels={selection.loadModels}
          value={{ agentId: selection.agentId, selection: selection.modelSelection }}
        />
      </div>

      <Collapsible onOpenChange={setNewWorktreeEnabled} open={newWorktree.enabled}>
        <CollapsibleTrigger asChild>
          <Button
            className="h-auto w-full justify-start gap-1.5 px-0 py-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${newWorktree.enabled ? "rotate-90" : ""}`}
            />
            Create a new worktree to fix on
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Branches a fresh worktree from this one and launches the agent there instead.
          </p>
          <div className="space-y-2">
            <Label htmlFor={branchId}>Branch name</Label>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              id={branchId}
              onChange={(event) => setBranch(event.target.value.replace(/\s+/g, "-"))}
              value={newWorktree.branch}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={titleId}>Display title</Label>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              id={titleId}
              onChange={(event) => setTitle(event.target.value)}
              value={newWorktree.title}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
