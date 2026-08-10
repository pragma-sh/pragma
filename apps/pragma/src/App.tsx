import { MotionConfig } from "motion/react";

import { AiSetupModal } from "@/components/ai/AiSetupModal";
import { ConfirmCloseProvider } from "@/components/editor/confirm-close";
import { GitHubSetupModal } from "@/components/github/GitHubSetupModal";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { PluginProvider } from "@/plugins/PluginProvider";
import { AiProvider } from "@/state/ai-context";
import { AutomationsProvider } from "@/state/automations-context";
import { GitHubProvider } from "@/state/github-context";
import { KanbanProvider } from "@/state/kanban-context";
import { OpenPortsProvider } from "@/state/open-ports-context";
import { ThemeProvider } from "@/state/theme-context";
import { WorkspaceProvider } from "@/state/workspace-context";
import { WorktreeCreationProvider } from "@/state/worktree-creation-context";

function App() {
  return (
    // `reducedMotion="user"` makes every motion component in the tree follow the
    // OS `prefers-reduced-motion` setting: transform and layout animations are
    // dropped to instant while opacity still cross-fades. Properties MotionConfig
    // cannot strip (sidebar `width`) go through `useMotionTransition`, and
    // CSS-driven animation is handled by the media query in `index.css`.
    <MotionConfig reducedMotion="user">
      <AiProvider>
        <GitHubProvider>
          <WorkspaceProvider>
            <ThemeProvider>
              <PluginProvider>
                <OpenPortsProvider>
                  <KanbanProvider>
                    <AutomationsProvider>
                      <ConfirmCloseProvider>
                        <WorktreeCreationProvider>
                          <WorkspaceShell />
                          <GitHubSetupModal />
                          <AiSetupModal />
                        </WorktreeCreationProvider>
                      </ConfirmCloseProvider>
                    </AutomationsProvider>
                  </KanbanProvider>
                </OpenPortsProvider>
              </PluginProvider>
            </ThemeProvider>
          </WorkspaceProvider>
        </GitHubProvider>
      </AiProvider>
    </MotionConfig>
  );
}

export default App;
