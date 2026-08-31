import { useEffect, useState } from "react";
import { Blocks, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import type { LockedPlugin } from "@pragma/plugin-registry";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  AGENT_COMMAND_SUBMITTED_EVENT,
  type AgentCommandSubmittedDetail,
  missingAgentPluginForCommand,
} from "@/lib/agent-plugin-prompt";
import { bundledOfficialPluginLock, installLockedPlugin } from "@/lib/plugin-registry";
import { agentPluginPromptDismissed, setAgentPluginPromptDismissed } from "@/lib/tauri";
import { useActivePlugins } from "@/plugins/registry";
import { useWorkspace } from "@/state/workspace-context";

/** Offers official integration when user manually runs an agent with only bundled launcher loaded. */
export function AgentPluginInstallPrompt() {
  const { selectedProjectId } = useWorkspace();
  const activePlugins = useActivePlugins(selectedProjectId);
  const [dismissed, setDismissed] = useState(true);
  const [plugin, setPlugin] = useState<LockedPlugin | null>(null);

  useEffect(() => {
    let cancelled = false;
    void agentPluginPromptDismissed()
      .then((value) => {
        if (!cancelled) setDismissed(value);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (dismissed) return;
    function onCommand(event: Event): void {
      const command = (event as CustomEvent<AgentCommandSubmittedDetail>).detail.command;
      const match = missingAgentPluginForCommand(
        command,
        activePlugins,
        bundledOfficialPluginLock(),
      );
      if (match) setPlugin(match);
    }
    window.addEventListener(AGENT_COMMAND_SUBMITTED_EVENT, onCommand);
    return () => window.removeEventListener(AGENT_COMMAND_SUBMITTED_EVENT, onCommand);
  }, [activePlugins, dismissed]);

  function install(): void {
    if (!plugin) return;
    const selected = plugin;
    setPlugin(null);
    void installLockedPlugin(selected).then(
      () => toast.success(`${selected.manifest.name} installed`),
      (cause: unknown) =>
        toast.error(`${selected.manifest.name} installation failed`, {
          description: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  }

  async function neverShowAgain(): Promise<void> {
    try {
      await setAgentPluginPromptDismissed(true);
      setDismissed(true);
      setPlugin(null);
    } catch (cause) {
      toast.error("Could not save preference", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return (
    <Dialog open={plugin !== null} onOpenChange={(open) => !open && setPlugin(null)}>
      <DialogContent className="max-w-lg gap-5">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
            <Blocks className="size-5" />
          </div>
          <div>
            <DialogTitle>
              {plugin ? `Connect ${plugin.manifest.name} to Pragma?` : "Connect agent"}
            </DialogTitle>
            <DialogDescription className="mt-1">
              Install its integration for live status, questions, and other supported agent
              features. Your current command will keep running.
            </DialogDescription>
          </div>
        </div>

        <p className="flex gap-2 text-xs leading-5 text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          Plugin can execute code and change agent configuration. Package and manifest are verified
          against Pragma's official lock before installation.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => void neverShowAgain()}>
            Don't show again
          </Button>
          <Button variant="outline" onClick={() => setPlugin(null)}>
            Not now
          </Button>
          <Button disabled={!plugin} onClick={install}>
            Install plugin
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
