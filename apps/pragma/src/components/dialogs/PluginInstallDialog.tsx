import { useEffect, useState } from "react";
import { Download, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import type { LockedPlugin } from "@pragma/plugin-registry";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  displayInstallCommand,
  installLockedPlugin,
  loadOfficialPluginLock,
} from "@/lib/plugin-registry";

export function PluginInstallDialog({
  packageName,
  open,
  onOpenChange,
}: {
  packageName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [plugin, setPlugin] = useState<LockedPlugin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!open || !packageName) return;
    setPlugin(null);
    setError(null);
    void loadOfficialPluginLock()
      .then((plugins) => {
        const match = plugins.find((entry) => entry.package === packageName);
        if (!match) throw new Error(`${packageName} is not in Pragma's official plugin list`);
        setPlugin(match);
        return undefined;
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open, packageName]);

  async function install() {
    if (!plugin) return;
    setInstalling(true);
    try {
      await installLockedPlugin(plugin);
      toast.success(`${plugin.manifest.name} installed`);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-5">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
            <Download className="size-5" />
          </div>
          <div>
            <DialogTitle>
              {plugin ? `Install ${plugin.manifest.name}` : "Install plugin"}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {plugin ? `${plugin.package}@${plugin.version}` : "Checking official plugin lock…"}
            </DialogDescription>
          </div>
        </div>

        {plugin ? (
          <>
            <p className="text-sm leading-6 text-muted-foreground">{plugin.manifest.description}</p>
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-2 flex items-center gap-2 text-xs font-medium">
                <ShieldAlert className="size-4" /> Command to run
              </p>
              <code className="break-all text-xs text-muted-foreground">
                {displayInstallCommand(plugin)}
              </code>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Plugins can execute code and change tool configuration. Package tarball and manifest
              are verified against Pragma's reviewed lock before this command runs.
            </p>
          </>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={installing} variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!plugin || installing} onClick={() => void install()}>
            {installing ? "Installing…" : "Install plugin"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
