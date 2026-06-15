import { ConfirmCloseProvider } from "@/components/editor/confirm-close";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { WorkspaceProvider } from "@/state/workspace-context";

function App() {
  return (
    <WorkspaceProvider>
      <ConfirmCloseProvider>
        <WorkspaceShell />
      </ConfirmCloseProvider>
    </WorkspaceProvider>
  );
}

export default App;
