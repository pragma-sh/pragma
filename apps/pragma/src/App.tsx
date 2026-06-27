import { AiSetupModal } from "@/components/ai/AiSetupModal";
import { ConfirmCloseProvider } from "@/components/editor/confirm-close";
import { GitHubSetupModal } from "@/components/github/GitHubSetupModal";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { AiProvider } from "@/state/ai-context";
import { GitHubProvider } from "@/state/github-context";
import { KanbanProvider } from "@/state/kanban-context";
import { WorkspaceProvider } from "@/state/workspace-context";

function App() {
  return (
    <AiProvider>
      <GitHubProvider>
        <WorkspaceProvider>
          <KanbanProvider>
            <ConfirmCloseProvider>
              <WorkspaceShell />
              <GitHubSetupModal />
              <AiSetupModal />
            </ConfirmCloseProvider>
          </KanbanProvider>
        </WorkspaceProvider>
      </GitHubProvider>
    </AiProvider>
  );
}

export default App;
