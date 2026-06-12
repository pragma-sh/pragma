import { useState, type FormEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createWorktree, listWorktrees } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentWorktreeId: string | null;
}

export function CreateWorktreeDialog({ open: isOpen, onOpenChange, parentWorktreeId }: Props) {
  const { state, dispatch } = useWorkspace();
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!state.activeProjectId || !parentWorktreeId) return;
    setError(null);
    setLoading(true);

    try {
      await createWorktree(state.activeProjectId, parentWorktreeId, branch, title || undefined);
      const worktrees = await listWorktrees(state.activeProjectId);
      dispatch({ type: "SET_WORKTREES", worktrees });
      onOpenChange(false);
      setBranch("");
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="branch">Branch name</Label>
            <Input
              id="branch"
              placeholder="feature/my-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">Title (optional)</Label>
            <Input
              id="title"
              placeholder="My worktree"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating..." : "Create worktree"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
