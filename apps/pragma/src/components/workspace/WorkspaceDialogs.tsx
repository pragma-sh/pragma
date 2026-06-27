import { useEffect, useState } from "react";

import { NewAgentSessionDialog } from "@/components/dialogs/NewAgentSessionDialog";
import {
  consumePendingNewSession,
  NEW_SESSION_EVENT,
  type NewSessionDeepLinkDetail,
} from "@/lib/deep-link";

/**
 * Always-mounted host for workspace-level dialogs that must work regardless of
 * which surface (normal shell or Kanban board) is visible. The new-session
 * dialog used to live in `ProjectSidebar`, but the sidebar is replaced by the
 * Kanban board in Kanban mode — so a `pragma://open` deep link would have had no
 * listener there. Hosting it here keeps deep links working in both modes.
 */
export function WorkspaceDialogs() {
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  const [newSessionInitial, setNewSessionInitial] = useState<NewSessionDeepLinkDetail | null>(null);

  // A `pragma://open` deep link (without auto-submit) opens the new-session
  // dialog prefilled with the link's values. The workspace owns deep-link
  // handling, so requests arrive via `requestNewSession`: drain any buffered
  // request on mount (a cold-start deep link is handled before this listener
  // exists) and also listen for live ones.
  useEffect(() => {
    function openPrefilled(detail: NewSessionDeepLinkDetail) {
      setNewSessionInitial(detail);
      setNewSessionDialogOpen(true);
    }
    function onEvent(event: Event) {
      // Clear the buffer too so a later remount doesn't reopen the same request.
      consumePendingNewSession();
      openPrefilled((event as CustomEvent<NewSessionDeepLinkDetail>).detail);
    }
    const pending = consumePendingNewSession();
    if (pending) {
      openPrefilled(pending);
    }
    window.addEventListener(NEW_SESSION_EVENT, onEvent);
    return () => window.removeEventListener(NEW_SESSION_EVENT, onEvent);
  }, []);

  return (
    <NewAgentSessionDialog
      open={newSessionDialogOpen}
      onOpenChange={setNewSessionDialogOpen}
      initial={newSessionInitial}
    />
  );
}
