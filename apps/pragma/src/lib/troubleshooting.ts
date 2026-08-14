import type { Tab } from "@pragma/constants";

import { restartDaemon } from "@/lib/tauri";

/** The slice of the workspace the troubleshooting actions need. */
export interface TroubleshootingWorkspace {
  tabs: Tab[];
  closeTab: (tabId: string) => Promise<void>;
}

/**
 * Restarts the persistent server, closing every tab first: the restart kills all
 * PTY sessions, so surviving tabs would only render dead terminals and stale views.
 */
export async function restartServer(workspace: TroubleshootingWorkspace): Promise<void> {
  await Promise.all(workspace.tabs.map((tab) => workspace.closeTab(tab.id)));
  await restartDaemon();
}

/**
 * Reloads the desktop UI webview without touching the server, so sessions keep
 * running and tabs re-attach on load. Recovers a wedged or stale frontend.
 */
export function reloadWebview(): void {
  window.location.reload();
}
