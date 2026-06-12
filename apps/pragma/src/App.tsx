import { WorkspaceProvider } from "@/state/workspace-context";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

function App() {
  return (
    <WorkspaceProvider>
      <WorkspaceShell />
    </WorkspaceProvider>
  );
}

export default App;
