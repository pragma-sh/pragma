import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { addProject, cloneProject } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ open: isOpen, onOpenChange }: Props) {
  const { state, dispatch } = useWorkspace();
  const [mode, setMode] = useState<"open" | "clone">("open");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function pickDirectory() {
    const selected = await open({
      directory: true,
      defaultPath: state.projectsDirectory ?? undefined,
    });
    if (selected) {
      setTargetDir(selected as string);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "open") {
        if (!targetDir) {
          setError("Select a project directory");
          setLoading(false);
          return;
        }
        const project = await addProject(targetDir);
        dispatch({ type: "SET_ACTIVE_PROJECT", projectId: project.id });
      } else {
        if (!remoteUrl) {
          setError("Enter a git remote URL");
          setLoading(false);
          return;
        }
        if (!targetDir) {
          setError("Select a clone destination");
          setLoading(false);
          return;
        }
        const project = await cloneProject(remoteUrl, targetDir);
        dispatch({ type: "SET_ACTIVE_PROJECT", projectId: project.id });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "open" | "clone")}
            className="flex gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="open" id="mode-open" />
              <Label htmlFor="mode-open">Open from disk</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="clone" id="mode-clone" />
              <Label htmlFor="mode-clone">Clone a remote</Label>
            </div>
          </RadioGroup>

          {mode === "clone" && (
            <div className="space-y-1.5">
              <Label htmlFor="remote-url">Git remote</Label>
              <Input
                id="remote-url"
                placeholder="git@github.com:user/repo.git"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{mode === "clone" ? "Clone destination" : "Project directory"}</Label>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={pickDirectory}
            >
              {targetDir ||
                (mode === "clone"
                  ? "Choose directory to clone into..."
                  : "Choose project directory...")}
            </Button>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Working..." : mode === "clone" ? "Clone & open" : "Open project"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
