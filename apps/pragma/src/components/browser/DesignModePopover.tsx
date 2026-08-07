import { useCallback, useEffect, useState } from "react";

import { X } from "lucide-react";
import { toast } from "sonner";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import type { StagedDesignChange } from "@/components/browser/use-design-mode";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAgentModels } from "@/hooks/use-agent-models";
import { useAgentsList } from "@/hooks/use-agents-list";
import { startBackgroundAgentSession } from "@/lib/agent-launch";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
} from "@/lib/agent-model-selection";
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
  const workspace = useWorkspace();
  const agents = useAgentsList();
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [selection, setSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const [launching, setLaunching] = useState(false);
  useSuppressNativeOverlayWhile(open);

  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  // Seed the picker with the first configured agent (and its remembered model)
  // so applying is one click when the user does not care which agent runs.
  useEffect(() => {
    const first = agents[0];
    if (agentId || !first) {
      return;
    }
    setAgentId(first.id);
    setSelection(defaultModelSelection(first.id, modelsByAgent[first.id] ?? []));
  }, [agents, agentId, modelsByAgent]);

  const handleAgentChange = useCallback((nextAgentId: string, next: AgentModelSelection) => {
    setAgentId(nextAgentId);
    setSelection(next);
    rememberModelSelection(nextAgentId, next);
  }, []);

  const apply = useCallback(async () => {
    const agent = agents.find((candidate) => candidate.id === agentId);
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
        prompt: buildDesignPrompt(changes, pageUrl),
        selection,
        refreshProject: workspace.refreshProject,
        markTabAgent: workspace.markTabAgent,
      });
      setOpen(false);
      onApplied();
      toast.success(
        `Sent ${changes.length} change${changes.length === 1 ? "" : "s"} to ${agent.name}`,
      );
    } catch {
      toast.error("Couldn't start the agent for these changes.");
    } finally {
      setLaunching(false);
    }
  }, [agents, agentId, workspace, changes, pageUrl, selection, onApplied]);

  const canApply = Boolean(agentId) && Boolean(workspace.selectedWorktree) && !launching;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`${changes.length} staged design ${changes.length === 1 ? "change" : "changes"}`}
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
              <Button
                aria-label={`Remove staged change ${index + 1}`}
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                size="icon-sm"
                variant="ghost"
                onClick={() => onRemove(change.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <AgentModelSelector
            agents={agents}
            label="Agent"
            modelsByAgent={modelsByAgent}
            onChange={handleAgentChange}
            onLoadModels={loadModels}
            value={{ agentId, selection }}
          />
          <Button className="w-full" disabled={!canApply} size="sm" onClick={() => void apply()}>
            {launching ? "Starting agent..." : "Apply changes with agent"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Opens a terminal tab for the agent **without stealing focus** — the tab is
 * created and its PTY started in the background (same path the Kanban board
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
