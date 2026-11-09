import { ComputerApprovalDialog } from "@/components/computer-use/ComputerApprovalDialog";
import { ComputerPip } from "@/components/computer-use/ComputerPip";
import { useComputerUse } from "@/state/computer-use-store";
import { useWorkspace } from "@/state/workspace-context";

/**
 * Main-window half of computer use: the in-app picture-in-picture panel and
 * the approval prompts.
 *
 * The panel shows the sessions of the selected worktree only, so switching
 * worktrees never leaves another worktree's agent on screen; the sidebar badge
 * marks the others. Sessions that belong to no worktree (scripts, the SDK) are
 * shown whatever is selected.
 */
export function ComputerUseController() {
  const { snapshot } = useComputerUse();
  const { selectedWorktreeId } = useWorkspace();
  const sessions = (snapshot?.sessions ?? []).filter(
    (session) => !session.worktreeId || session.worktreeId === selectedWorktreeId,
  );
  return (
    <>
      {sessions.length > 0 ? <ComputerPip sessions={sessions} /> : null}
      <ComputerApprovalDialog approvals={snapshot?.approvals ?? []} />
    </>
  );
}
