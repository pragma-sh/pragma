import { useProject } from "@pragma/plugin";
import { Button, Kbd } from "@pragma/plugin/ui";

import { openReportWebView } from "./report-webview";

/** Primary sidebar tab: a tiny "hello" surface kept close to the scaffold. */
export function OverviewTab() {
  const project = useProject();
  return (
    <div style={{ padding: 12 }}>
      <h2>Pragma Dev Test Plugin</h2>
      <p>Active project: {project?.name ?? "None"}</p>
      <Button variant="secondary" size="sm">
        Press <Kbd>⌘K</Kbd>
      </Button>
      <Button size="sm" style={{ marginLeft: 8 }} variant="secondary" onClick={openReportWebView}>
        Open Plugin Report
      </Button>
    </div>
  );
}
