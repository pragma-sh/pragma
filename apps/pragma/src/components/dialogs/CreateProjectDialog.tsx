import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addProject, cloneProject, getProjectsDirectory, pickDirectory } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ open: isOpen, onOpenChange }: CreateProjectDialogProps) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const workspace = useWorkspace();

  if (!isOpen) {
    return null;
  }

  async function openExisting() {
    try {
      const defaultPath = await getProjectsDirectory();
      const selected = await pickDirectory(defaultPath);
      if (selected === null) {
        return;
      }
      const project = await addProject(selected);
      await workspace.reload();
      await workspace.selectProject(project.id);
      onOpenChange(false);
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  async function cloneRemote() {
    try {
      const defaultPath = await getProjectsDirectory();
      const selected = await pickDirectory(defaultPath);
      if (selected === null) {
        return;
      }
      const project = await cloneProject(remoteUrl, selected);
      await workspace.reload();
      await workspace.selectProject(project.id);
      onOpenChange(false);
    } catch (cause) {
      setError(messageFor(cause));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-5 shadow-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Add project</h2>
          <p className="text-sm text-muted-foreground">
            Use the native directory picker or clone into a selected folder.
          </p>
        </div>
        <div className="mt-5 space-y-4">
          <Button className="w-full" onClick={() => void openExisting()}>
            Open existing git checkout
          </Button>
          <div className="space-y-2">
            <Label htmlFor="remote-url">Remote URL</Label>
            <Input
              id="remote-url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder="git@github.com:owner/repo.git"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
            <Button
              className="w-full"
              disabled={!remoteUrl.trim()}
              variant="outline"
              onClick={() => void cloneRemote()}
            >
              Clone remote
            </Button>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
