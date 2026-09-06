import { useEffect, useState } from "react";
import { FileCog } from "lucide-react";
import { toast } from "sonner";

import { constants } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/errors";
import {
  applyScriptMigration,
  detectScriptMigration,
  dismissScriptMigration,
  type ScriptMigrationOffer,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

/** Lifecycle sections listed in the prompt, in the order they run. */
const SECTIONS = [
  { key: "setup", label: "Setup" },
  { key: "run", label: "Run" },
  { key: "teardown", label: "Teardown" },
] as const;

/**
 * Offers to import another orchestrator's checked-in lifecycle scripts when a
 * project is opened with a Superset, Emdash, or Orca config but no
 * `.pragma/scripts.json` of its own. The backend picks one source when several
 * exist, so the prompt is always about a single config.
 */
export function ScriptMigrationDialog() {
  const { selectedProjectId } = useWorkspace();
  const [offer, setOffer] = useState<ScriptMigrationOffer | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [commit, setCommit] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOffer(null);
    setProjectId(null);
    if (!selectedProjectId) {
      return;
    }
    const detectedFor = selectedProjectId;
    let cancelled = false;
    void detectScriptMigration(detectedFor)
      .then((detected) => {
        if (!cancelled && detected) {
          setOffer(detected);
          setProjectId(detectedFor);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  function close(): void {
    setOffer(null);
    setProjectId(null);
  }

  async function importConfig(): Promise<void> {
    if (!offer || !projectId) return;
    setBusy(true);
    try {
      await applyScriptMigration(projectId, commit);
      toast.success(`Imported ${offer.sourceLabel} scripts`, {
        description: commit
          ? `Wrote and committed ${constants.scripts.configPath}.`
          : `Wrote ${constants.scripts.configPath}.`,
      });
      close();
    } catch (cause) {
      toast.error("Could not import scripts", { description: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function skip(): Promise<void> {
    if (!projectId) return;
    try {
      await dismissScriptMigration(projectId);
    } catch (cause) {
      toast.error("Could not save preference", { description: errorMessage(cause) });
    }
    close();
  }

  return (
    <Dialog open={offer !== null} onOpenChange={(open) => !open && close()}>
      {/* `sm:` prefixed, because the base `sm:max-w-sm` in `DialogContent` wins
          over an unprefixed override at every width the app is used at. */}
      <DialogContent className="gap-5 sm:max-w-2xl">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
            <FileCog className="size-5" />
          </div>
          <div>
            <DialogTitle>
              {offer ? `Import ${offer.sourceLabel} scripts?` : "Import project scripts"}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {offer ? (
                <>
                  This project has <code>{offer.configPath}</code>. Pragma can copy its setup, run,
                  and teardown commands into <code>{constants.scripts.configPath}</code>.
                </>
              ) : null}
            </DialogDescription>
          </div>
        </div>

        {offer ? (
          <div className="max-h-56 overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs">
            {SECTIONS.filter((section) => offer[section.key].length > 0).map((section) => (
              <div key={section.key} className="not-first:mt-3">
                <p className="font-medium text-muted-foreground">{section.label}</p>
                <ul className="mt-1 space-y-1">
                  {offer[section.key].map((command) => (
                    <li key={command} className="truncate font-mono" title={command}>
                      {command}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Switch id="commit-imported-scripts" checked={commit} onCheckedChange={setCommit} />
          <Label htmlFor="commit-imported-scripts" className="text-sm font-normal">
            Commit the imported config
          </Label>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void skip()}>
            Don't ask again
          </Button>
          <Button variant="outline" disabled={busy} onClick={close}>
            Not now
          </Button>
          <Button disabled={busy || !offer} onClick={() => void importConfig()}>
            Import scripts
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
