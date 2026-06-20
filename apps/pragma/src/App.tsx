import { ConfirmCloseProvider } from "@/components/editor/confirm-close";
import { GitHubSetupModal } from "@/components/github/GitHubSetupModal";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { GitHubProvider } from "@/state/github-context";
import { WorkspaceProvider } from "@/state/workspace-context";

function App() {
  return (
    <GitHubProvider>
      <WorkspaceProvider>
        <ConfirmCloseProvider>
          <WorkspaceShell />
          <GitHubSetupModal />
        </ConfirmCloseProvider>
      </WorkspaceProvider>
    </GitHubProvider>
  );
}

export default App;
