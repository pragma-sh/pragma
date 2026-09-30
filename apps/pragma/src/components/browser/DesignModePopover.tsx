import { useMemo, useState } from "react";

import { X } from "lucide-react";
import { toast } from "sonner";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import type { StagedDesignChange } from "@/components/browser/use-design-mode";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentSelection } from "@/hooks/use-agent-selection";
import { useAutoSubmit } from "@/hooks/use-auto-agent-selection";
import { useAutoTarget } from "@/hooks/use-auto-target";
import { startBackgroundAgentSession } from "@/lib/agent-launch";
import { buildDesignPrompt } from "@/lib/design-mode";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import { defaultTabTitle } from "@/lib/tab-title";
import { type AgentConfig, type AgentModelSelection, createTab } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface DesignModePopoverProps {
  /** Changes staged from the page, oldest first. */
  changes: StagedDesignChange[];
  /** URL the changes were picked on, used for the origin/port in the prompt. */
  pageUrl: string;
  /** Drops one staged change. */
  onRemove: (id: string) => void;
  /** Called once the agent has been launched with the staged changes. */
  onApplied: () => void;
}

/**
 * The staged-changes list for design mode: every prompt the user added, plus
 * the agent/model picker that hands them all to a background agent session.
 *
 * Rendered as a count badge next to the design-mode toggle; it only exists
 * while at least one change is staged.
 */
export function DesignModePopover({
  changes,
  pageUrl,
  onRemove,
  onApplied,
}: DesignModePopoverProps) {
  const [open, setOpen] = useState(false);
  useSuppressNativeOverlayWhile(open);
  const plural = changes.length === 1 ? "change" : "changes";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`${changes.length} staged design ${plural}`}
          className="h-6 min-w-6 rounded-full px-1.5 text-xs tabular-nums"
          size="sm"
          variant="secondary"
        >
          {changes.length}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <PopoverHeader>
          <PopoverTitle>Staged changes</PopoverTitle>
        </PopoverHeader>
        <StagedChangeList changes={changes} onRemove={onRemove} />
        <DesignAgentPanel
          changes={changes}
          pageUrl={pageUrl}
          onLaunched={() => {
            setOpen(false);
            onApplied();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function StagedChangeList({
  changes,
  onRemove,
}: {
  changes: StagedDesignChange[];
  onRemove: (id: string) => void;
}) {
  return (
    <ol className="max-h-64 space-y-2 overflow-y-auto">
      {changes.map((change, index) => (
        <li className="flex items-start gap-2 text-sm" key={change.id}>
          <span className="w-4 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block break-words text-foreground">{change.prompt}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {change.route} · {change.selector}
            </span>
          </span>
          <IconButton
            aria-label={`Remove staged change ${index + 1}`}
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            label="Remove change"
            size="icon-sm"
            variant="ghost"
            onClick={() => onRemove(change.id)}
          >
            <X />
          </IconButton>
        </li>
      ))}
    </ol>
  );
}

/** The agent picker (with Auto) and the button that launches the staged changes. */
function DesignAgentPanel({
  changes,
  pageUrl,
  onLaunched,
}: {
  changes: StagedDesignChange[];
  pageUrl: string;
  onLaunched: () => void;
}) {
  const workspace = useWorkspace();
  // Mounted only while the popover is open, so the picker is always active.
  const picker = useAgentSelection(true);
  const [launching, setLaunching] = useState(false);
  const designPrompt = useMemo(() => buildDesignPrompt(changes, pageUrl), [changes, pageUrl]);
  const autoTarget = useAutoTarget(designPrompt);

  async function apply() {
    const agent = picker.selectedAgent;
    const worktree = workspace.selectedWorktree;
    const projectId = workspace.selectedProjectId;
    if (!agent || !worktree || !projectId) {
      return;
    }
    setLaunching(true);
    try {
      await launchDesignAgent({
        agent,
        projectId,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        prompt: designPrompt,
        selection: picker.modelSelection,
        refreshProject: workspace.refreshProject,
        markTabAgent: workspace.markTabAgent,
      });
      onLaunched();
      toast.success(
        `Sent ${changes.length} change${changes.length === 1 ? "" : "s"} to ${agent.name}`,
      );
    } catch {
      toast.error("Couldn't start the agent for these changes.");
    } finally {
      setLaunching(false);
    }
  }

  const auto = useAutoSubmit(apply);
  // Auto choosing for this submit holds the button, like a launch does.
  const busy = launching || auto.resolving;
  const canApply = Boolean(picker.selectedAgent) && Boolean(workspace.selectedWorktree) && !busy;

  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <AgentModelSelector
        agents={picker.agents}
        label="Agent"
        modelsByAgent={picker.modelsByAgent}
        onChange={picker.handleAgentChange}
        onLoadModels={picker.loadModels}
        value={{ agentId: picker.agentId, selection: picker.modelSelection }}
        autoTarget={autoTarget}
        autoRegistry={auto.registry}
      />
      <Button className="w-full" disabled={!canApply} size="sm" onClick={() => void auto.submit()}>
        {launching ? "Starting agent..." : "Apply changes with agent"}
      </Button>
    </div>
  );
}

/**
 * Opens a terminal tab for the agent **without stealing focus** — the tab is
 * created and its PTY started in the background (same path the agent board
 * uses), so the user keeps looking at the page they were designing.
 */
async function launchDesignAgent(input: {
  agent: AgentConfig;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  prompt: string;
  selection: AgentModelSelection;
  refreshProject: (projectId?: string | null) => Promise<void>;
  markTabAgent: (tabId: string, agent: AgentConfig) => Promise<void>;
}): Promise<void> {
  const tab = await createTab(
    input.projectId,
    input.worktreeId,
    "terminal",
    defaultTabTitle("terminal"),
  );
  await input.refreshProject(input.projectId);
  await input.markTabAgent(tab.id, input.agent);
  await startBackgroundAgentSession(
    tab.id,
    input.worktreeId,
    input.worktreePath,
    input.agent,
    input.prompt,
    input.selection,
  );
}
