import { useEffect, useMemo, useState } from "react";

import { GitBranch } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { startAgentInTab } from "@/lib/agent-launch";
import { isMacPlatform } from "@/lib/platform";
import { type AgentConfig, listAgents } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface NewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Starts a fresh agent thread: the user writes a markdown prompt, picks an agent
 * and a target worktree, then submits (⌘/Ctrl+↵ or the button). Submitting
 * switches to the chosen worktree, opens a terminal tab, launches the agent, and
 * prefills the prompt into the agent's TUI without sending it.
 */
export function NewChatDialog({ open: isOpen, onOpenChange }: NewChatDialogProps) {
  const workspace = useWorkspace();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  const worktrees = useMemo(
    () =>
      workspace.selectedProjectId
        ? (workspace.worktrees[workspace.selectedProjectId] ?? []).filter((w) => !w.hidden)
        : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );

  // Load the configured agents whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    listAgents()
      .then((items) => {
        if (!cancelled) {
          setAgents(Array.isArray(items) ? items : []);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Seed the dropdowns each time the dialog opens: first agent, current worktree.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setWorktreeId((current) => current ?? workspace.selectedWorktreeId);
  }, [isOpen, workspace.selectedWorktreeId]);

  useEffect(() => {
    if (isOpen && agentId === null && agents.length > 0) {
      setAgentId(agents[0]!.id);
    }
  }, [isOpen, agentId, agents]);

  if (!isOpen) {
    return null;
  }

  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const canSubmit = Boolean(selectedAgent && worktreeId && message.trim());

  async function submit() {
    if (!workspace.selectedProjectId || !worktreeId || !selectedAgent) {
      return;
    }
    try {
      workspace.selectWorktree(worktreeId);
      const tab = await workspace.createTerminalTab(worktreeId);
      if (!tab) {
        return;
      }
      startAgentInTab(tab.id, selectedAgent, message);
      onOpenChange(false);
      setMessage("");
      setAgentId(null);
      setWorktreeId(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter") {
      return;
    }
    const isModEnter = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
    if (!isModEnter || !canSubmit) {
      return;
    }
    event.preventDefault();
    void submit();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Start a new chat</h2>
          <p className="text-sm text-muted-foreground">
            Write a prompt, pick an agent and a worktree, then launch a session.
          </p>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={message}
              onChange={setMessage}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want the agent to do…"
              className="min-h-40"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Agent</Label>
              <Select value={agentId ?? undefined} onValueChange={setAgentId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select agent">
                    {selectedAgent ? (
                      <>
                        <AgentIcon agent={selectedAgent} />
                        <span className="truncate">{selectedAgent.name}</span>
                      </>
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {agents.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No agents configured
                    </SelectItem>
                  ) : (
                    agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <AgentIcon agent={agent} />
                        <span className="truncate">{agent.name}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Worktree</Label>
              <Select value={worktreeId ?? undefined} onValueChange={setWorktreeId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select worktree" />
                </SelectTrigger>
                <SelectContent>
                  {worktrees.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      No worktrees available
                    </SelectItem>
                  ) : (
                    worktrees.map((worktree) => (
                      <SelectItem key={worktree.id} value={worktree.id}>
                        <GitBranch className="size-3.5" />
                        <span className="truncate">
                          {worktree.isMain ? "main" : (worktree.title ?? worktree.branch)}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Start session
              <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
