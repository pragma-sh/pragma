import { useEffect, useRef, useState } from "react";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { MarkdownEditor } from "@/components/github/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgentModels } from "@/hooks/use-agent-models";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import {
  EMPTY_MODEL_SELECTION,
  defaultModelSelection,
  rememberModelSelection,
  validateModelSelection,
} from "@/lib/agent-model-selection";
import { isMacPlatform } from "@/lib/platform";
import {
  type AgentConfig,
  type AgentModelSelection,
  createWorktree,
  listAgents,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Structural subset shared by the DOM and React keyboard events the form fields emit. */
type SubmitKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & {
  preventDefault: () => void;
};

/**
 * Creates a nested worktree and, when a prompt is given, immediately starts an
 * agent session in it: the user names the branch (and an optional display
 * title), picks an agent, optionally writes a markdown prompt, then submits
 * (⌘/Ctrl+↵ or the button). An empty prompt just creates the worktree and opens
 * a terminal in it — no agent session is started.
 */
export function CreateWorktreeDialog({ open: isOpen, onOpenChange }: CreateWorktreeDialogProps) {
  const workspace = useWorkspace();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { modelsByAgent, loadModels, primeFromCache } = useAgentModels();
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<AgentModelSelection>(EMPTY_MODEL_SELECTION);
  const [error, setError] = useState<string | null>(null);
  const previousAgentIdRef = useRef<string | null>(null);
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

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

  // Show already-resolved models immediately, without waiting for a hover.
  useEffect(() => {
    primeFromCache(agents.map((agent) => agent.id));
  }, [agents, primeFromCache]);

  // Keep a valid agent selected, falling back to the first (default) agent.
  useEffect(() => {
    if (!isOpen || agents.length === 0) {
      return;
    }
    setAgentId((current) =>
      current && agents.some((agent) => agent.id === current) ? current : agents[0]!.id,
    );
  }, [isOpen, agents]);

  useEffect(() => {
    if (!isOpen || !agentId) {
      return;
    }
    const models = modelsByAgent[agentId];
    if (!models) {
      return;
    }
    const changedAgent = previousAgentIdRef.current !== agentId;
    previousAgentIdRef.current = agentId;
    setModelSelection((current) => {
      if (changedAgent) {
        return defaultModelSelection(agentId, models);
      }
      const valid = validateModelSelection(models, current);
      return valid.modelId === null && current.modelId !== null
        ? defaultModelSelection(agentId, models)
        : valid;
    });
  }, [isOpen, agentId, modelsByAgent]);

  if (!isOpen) {
    return null;
  }

  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const canSubmit = branch.trim().length > 0;

  async function submit() {
    if (!workspace.selectedProjectId || !workspace.selectedWorktreeId || !canSubmit) {
      return;
    }
    try {
      const worktree = await createWorktree(
        workspace.selectedProjectId,
        workspace.selectedWorktreeId,
        branch,
        title.trim() || undefined,
      );
      // Load the new worktree into state first so its terminal tab resolves its
      // cwd to the new worktree path.
      await workspace.refreshProject(workspace.selectedProjectId);
      const prompt = message.trim();
      if (prompt && selectedAgent) {
        // A prompt was written: launch an agent session seeded with it.
        rememberModelSelection(selectedAgent.id, modelSelection);
        await workspace.startSession(worktree.id, selectedAgent, prompt, modelSelection);
      } else {
        // No prompt: just open a terminal in the new worktree.
        workspace.selectWorktree(worktree.id);
        await workspace.createTerminalTab(worktree.id);
      }
      onOpenChange(false);
      setBranch("");
      setTitle("");
      setMessage("");
      setModelSelection(EMPTY_MODEL_SELECTION);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleAgentChange(nextAgentId: string, nextSelection: AgentModelSelection) {
    setAgentId(nextAgentId);
    setModelSelection(nextSelection);
    rememberModelSelection(nextAgentId, nextSelection);
  }

  function handleKeyDown(event: SubmitKeyEvent) {
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
      <div className="w-full max-w-2xl rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">New worktree at</h2>
          <p className="text-sm text-muted-foreground">
            Branches from the selected parent worktree HEAD. Add a prompt to launch an agent session
            in it.
          </p>
        </div>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="branch">Branch name</Label>
              <Input
                id="branch"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                value={branch}
                onChange={(event) => setBranch(event.target.value.replace(/\s+/g, "-"))}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">Display title</Label>
              <Input
                id="title"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div className="space-y-2">
              <Label>Agent</Label>
              <AgentModelSelector
                agents={agents}
                modelsByAgent={modelsByAgent}
                value={{ agentId, selection: modelSelection }}
                onChange={handleAgentChange}
                onLoadModels={loadModels}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Prompt</Label>
            <MarkdownEditor
              value={message}
              onChange={setMessage}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want the agent to do… (leave empty to skip the session)"
              className="min-h-40"
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Create worktree
              <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
