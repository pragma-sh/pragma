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

function App() {
  return (
    <AiProvider>
      <GitHubProvider>
        <WorkspaceProvider>
          <ThemeProvider>
            <PluginProvider>
              <OpenPortsProvider>
                <KanbanProvider>
                  <AutomationsProvider>
                    <ConfirmCloseProvider>
                      <WorkspaceShell />
                      <GitHubSetupModal />
                      <AiSetupModal />
                    </ConfirmCloseProvider>
                  </AutomationsProvider>
                </KanbanProvider>
              </OpenPortsProvider>
            </PluginProvider>
          </ThemeProvider>
        </WorkspaceProvider>
      </GitHubProvider>
    </AiProvider>
  );
}

export default App;
