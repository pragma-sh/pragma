import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { isMacPlatform } from "@/lib/platform";
import { createWorktree } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorktreeDialog({ open: isOpen, onOpenChange }: CreateWorktreeDialogProps) {
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const workspace = useWorkspace();
  const submitShortcut = isMacPlatform() ? "⌘↵" : "Ctrl+↵";
  useEscapeToClose(isOpen, () => onOpenChange(false));

  if (!isOpen) {
    return null;
  }

  async function submit() {
    if (!workspace.selectedProjectId || !workspace.selectedWorktreeId) {
      return;
    }
    try {
      const worktree = await createWorktree(
        workspace.selectedProjectId,
        workspace.selectedWorktreeId,
        branch,
        title.trim() || undefined,
      );
      // Load the new worktree into state first so the auto-created tab resolves
      // its cwd to the new worktree path, then open a terminal there.
      await workspace.refreshProject(workspace.selectedProjectId);
      workspace.selectWorktree(worktree.id);
      await workspace.createTerminalTab(worktree.id);
      onOpenChange(false);
      setBranch("");
      setTitle("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }
    const isModEnter = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
    if (!isModEnter || !branch.trim()) {
      return;
    }
    event.preventDefault();
    void submit();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {workspace.selectedWorktree?.isMain
              ? "Create a new worktree off main"
              : "Create a new worktree"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Branches from the selected parent worktree HEAD.
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!branch.trim()}>
              Create worktree
              <span className="ml-2 text-xs opacity-70">{submitShortcut}</span>
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
