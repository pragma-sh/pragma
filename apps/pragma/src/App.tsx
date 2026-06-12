import { useState } from "react";

import { constants, type AppInfo } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { getAppInfo } from "@/lib/tauri";

function App() {
  const [backend, setBackend] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pingBackend() {
    try {
      setBackend(await getAppInfo());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
      <header className="space-y-1">
        <h1 className="text-4xl font-bold tracking-tight">{constants.app.name}</h1>
        <p className="text-muted-foreground text-sm">
          v{constants.app.version} · {constants.app.identifier}
        </p>
        <p className="text-muted-foreground text-sm">
          Runs up to {constants.maxParallelAgents} agents in parallel
        </p>
      </header>

      <Button onClick={pingBackend}>Ping Rust backend</Button>

      {backend ? (
        <p className="text-sm">
          Backend reports <strong>{backend.name}</strong> v{backend.version}
        </p>
      ) : null}

      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </main>
  );
}

export default App;
