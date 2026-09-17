import { useState } from "react";

import { useNotify, useProject, useStoredState, useTheme } from "@pragma/plugin";
import { Button } from "@pragma/plugin/ui";

const rowStyle = { display: "flex", gap: 8, justifyContent: "space-between" } as const;

/**
 * Second Settings page, so the Plugins list shows more than one nested option
 * under this plugin. Reports host state and persists a counter through plugin
 * storage.
 */
export function DevTestDiagnosticsPage() {
  const project = useProject();
  const theme = useTheme();
  const notify = useNotify();
  const [saved, setSaved] = useStoredState<number>("dev-test-plugin.diagnostics.checks", 0);
  const [checks, setChecks] = useState<number>(saved);

  function runCheck() {
    const next = checks + 1;
    setChecks(next);
    setSaved(next);
    notify("Diagnostics check recorded", { variant: "success" });
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h2>Diagnostics</h2>
        <p>Host state this plugin can see, and a counter kept in plugin storage.</p>
      </div>
      <dl style={{ display: "grid", gap: 8 }}>
        <div style={rowStyle}>
          <dt>Active project</dt>
          <dd data-testid="diagnostics-project">{project?.name ?? "None"}</dd>
        </div>
        <div style={rowStyle}>
          <dt>Theme</dt>
          <dd data-testid="diagnostics-theme">{theme}</dd>
        </div>
        <div style={rowStyle}>
          <dt>Checks run</dt>
          <dd data-testid="diagnostics-checks">{checks}</dd>
        </div>
      </dl>
      <div>
        <Button onClick={runCheck}>Run check</Button>
      </div>
    </div>
  );
}
