import { useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { toast } from "sonner";

import { MiniWindow } from "@/components/mini/MiniWindow";
import { useMiniCatalog } from "@/components/mini/use-mini-catalog";
import { PluginRuntimeProvider, type PluginRuntimeScope } from "@/plugins/PluginProvider";
import { ThemeScopeProvider } from "@/state/theme-context";

/** Plugin web views are workspace tabs, which a mini window does not have. */
async function openPluginWebViewInMainWindow(): Promise<void> {
  toast.info("Plugin views open in the main Pragma window.");
}

/**
 * Root of a Pragma Mini window (`main.tsx` renders it instead of `App` when the
 * window label is a mini one). Deliberately lean: no workspace, onboarding, or
 * board — just the theme and the plugin runtime (which supplies launchable
 * agents), both scoped to the active tab's project.
 */
export function MiniApp() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const { catalog, reload: reloadCatalog } = useMiniCatalog();
  const scope = useMemo<PluginRuntimeScope>(
    () => ({
      projects: catalog.projects,
      projectTabs: [],
      selectedProjectId: activeProjectId,
      worktrees: catalog.worktrees,
      openPluginWebView: openPluginWebViewInMainWindow,
    }),
    [catalog, activeProjectId],
  );
  return (
    <MotionConfig reducedMotion="user">
      <ThemeScopeProvider projectId={activeProjectId}>
        <PluginRuntimeProvider scope={scope}>
          <MiniWindow
            catalog={catalog}
            onActiveProjectChange={setActiveProjectId}
            onCatalogStale={reloadCatalog}
          />
        </PluginRuntimeProvider>
      </ThemeScopeProvider>
    </MotionConfig>
  );
}
