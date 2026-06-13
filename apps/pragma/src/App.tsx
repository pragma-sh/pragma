import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { WorkspaceProvider } from "@/state/workspace-context";

function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceShell />
    </WorkspaceProvider>
  );
}

export default App;
