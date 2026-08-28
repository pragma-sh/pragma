import { useEffect, useState } from "react";
import { Blocks, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import type { LockedPlugin } from "@pragma/plugin-registry";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { bundledOfficialPluginLock, installLockedPlugin } from "@/lib/plugin-registry";
import {
  availablePluginBinaries,
  pluginOnboardingDismissed,
  setPluginOnboardingDismissed,
} from "@/lib/tauri";
import { useAi } from "@/state/ai-context";
import { useGitHub } from "@/state/github-context";

/** Final first-run step: recommends official integrations for agent CLIs already installed. */
export function AgentPluginSetupModal() {
  const github = useGitHub();
  const ai = useAi();
  const [recommended, setRecommended] = useState<LockedPlugin[]>([]);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const previousSetupFinished =
    !github.loading && !ai.loading && !github.needsSetup && !ai.needsSetup;

  useEffect(() => {
    if (!previousSetupFinished) return;
    let cancelled = false;
    void pluginOnboardingDismissed()
      .then(async (wasDismissed) => {
        const plugins = bundledOfficialPluginLock();
        const candidates = plugins.filter(
          (plugin) =>
            plugin.manifest.categories?.includes("agent-plugin") && plugin.manifest.agentBinary,
        );
        const binaries = candidates.flatMap((plugin) => plugin.manifest.agentBinary ?? []);
        const available = new Set(await availablePluginBinaries(binaries));
        if (!cancelled) {
          const recommendations = candidates.filter((plugin) =>
            available.has(plugin.manifest.agentBinary ?? ""),
          );
          setRecommended(recommendations);
          setSelectedPackages(new Set(recommendations.map((plugin) => plugin.package)));
          setDismissed(wasDismissed);
          setLoaded(true);
        }
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [previousSetupFinished]);

  const open = previousSetupFinished && loaded && !dismissed && recommended.length > 0;

  function finish() {
    setDismissed(true);
    void setPluginOnboardingDismissed(true).catch((cause: unknown) => {
      toast.error("Could not save agent plugin preference", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  function installRecommended() {
    const selected = recommended.filter((plugin) => selectedPackages.has(plugin.package));
    finish();
    void selected
      .reduce(
        (previous, plugin) =>
          previous.then(() =>
            installLockedPlugin(plugin).catch((cause: unknown) => {
              const message = cause instanceof Error ? cause.message : String(cause);
              throw new Error(`${plugin.manifest.name}: ${message}`);
            }),
          ),
        Promise.resolve(),
      )
      .then(
        () => toast.success("Recommended agent plugins installed"),
        (cause: unknown) =>
          toast.error("Recommended agent plugin installation failed", {
            description: cause instanceof Error ? cause.message : String(cause),
          }),
      );
  }

  return (
    <Dialog open={open}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <div className="flex shrink-0 flex-col items-center gap-2 px-6 pt-8 pb-6 text-center">
          <div className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-muted">
            <Blocks className="size-6" />
          </div>
          <DialogTitle className="text-base">Connect installed agents</DialogTitle>
          <DialogDescription className="max-w-sm">
            Pragma found agent CLIs on this machine. Install their integrations for status,
            questions, and usage inside Pragma.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6">
          <ul className="divide-y rounded-md border">
            {recommended.map((plugin) => (
              <li key={plugin.package}>
                <label className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm font-medium">{plugin.manifest.name}</span>
                  <Checkbox
                    checked={selectedPackages.has(plugin.package)}
                    onCheckedChange={(checked) => {
                      setSelectedPackages((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(plugin.package);
                        else next.delete(plugin.package);
                        return next;
                      });
                    }}
                  />
                </label>
              </li>
            ))}
          </ul>

          <p className="flex gap-2 py-6 text-xs leading-5 text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            These commands can change agent configuration. Each package and manifest is verified
            against Pragma's official lock first.
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t bg-background px-6 py-4 sm:flex-row">
          <Button
            className="min-w-0 flex-1 whitespace-normal"
            disabled={selectedPackages.size === 0}
            onClick={installRecommended}
          >
            Install selected agents
          </Button>
          <Button className="min-w-0 flex-1 whitespace-normal" variant="outline" onClick={finish}>
            I'll install them myself
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
