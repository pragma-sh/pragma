import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { toast } from "sonner";

import type { ComputerApproval } from "@pragma-sh/constants";

import { ComputerPermissionControls } from "@/components/computer-use/ComputerPermissionControls";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useComputerPermissions } from "@/hooks/use-computer-permissions";
import { errorMessage } from "@/lib/errors";
import { answerApproval, refreshComputerUse } from "@/state/computer-use-store";

/**
 * The prompt an agent's first computer-use request (or a sensitive control,
 * like a Delete button) raises. Only this window can answer it: the agent's
 * request waits on the host until the user picks, or until it times out.
 */
export function ComputerApprovalDialog({ approvals }: { approvals: ComputerApproval[] }) {
  const approval = approvals[0] ?? null;
  return approval ? <ComputerApprovalPrompt approval={approval} key={approval.id} /> : null;
}

function ComputerApprovalPrompt({ approval }: { approval: ComputerApproval }) {
  const [busy, setBusy] = useState(false);
  const { permissions, needsPermissions, error, requesting, load } = useComputerPermissions();
  const ready = permissions !== null && !needsPermissions && !error;

  // The host withdraws an unanswered prompt when it expires; re-read the
  // picture then too, so a missed event never leaves a dead prompt open.
  const expiresAt = approval.expiresAt;
  useEffect(() => {
    const timer = window.setTimeout(
      () => void refreshComputerUse(),
      Math.max(0, expiresAt - Date.now()) + 500,
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const answer = async (decision: "once" | "session" | "always" | "deny") => {
    setBusy(true);
    try {
      await answerApproval(approval, decision);
    } catch (cause) {
      // Most often the request already timed out on the host; drop the prompt.
      await refreshComputerUse();
      toast.error(
        approval.expiresAt <= Date.now()
          ? "That request already timed out. Ask the agent to try again."
          : `Could not answer: ${errorMessage(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <MousePointer2 />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {needsPermissions ? "Enable computer-use permissions" : approval.reason}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {approvalDescription(approval, needsPermissions, ready)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!ready ? (
          <div className="flex flex-col gap-4" aria-live="polite">
            {needsPermissions && permissions ? (
              <ComputerPermissionControls
                permissions={permissions}
                requesting={requesting}
                request={load}
              />
            ) : !error ? (
              <p className="text-sm text-muted-foreground">Checking permissions…</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button disabled={busy} onClick={() => void answer("deny")} variant="outline">
            Deny
          </Button>
          <ApprovalActions
            approval={approval}
            ready={ready}
            error={error}
            busy={busy}
            answer={answer}
            load={load}
          />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function approvalDescription(
  approval: ComputerApproval,
  needsPermissions: boolean,
  ready: boolean,
): string {
  if (needsPermissions)
    return "Before approving this request, allow Accessibility and Screen Recording for Pragma Computer Use in macOS. This popup will continue automatically once both are enabled.";
  if (!ready) return "Checking computer-use permissions before continuing.";
  if (approval.sensitive)
    return "This control can change or send something. Allow just this one action?";
  const target = approval.target?.appName;
  return `It will be able to read the screen and click and type${target ? ` in ${target}` : ""} while you watch. You can stop it at any time from the sidebar or with the stop shortcut.`;
}

function ApprovalActions({
  approval,
  ready,
  error,
  busy,
  answer,
  load,
}: {
  approval: ComputerApproval;
  ready: boolean;
  error: string | null;
  busy: boolean;
  answer: (decision: "once" | "session" | "always" | "deny") => Promise<void>;
  load: () => Promise<void>;
}) {
  if (!ready)
    return error ? (
      <Button onClick={() => void load()} variant="outline">
        Check again
      </Button>
    ) : null;
  if (approval.sensitive)
    return (
      <Button disabled={busy} onClick={() => void answer("once")}>
        Allow once
      </Button>
    );
  return (
    <>
      <Button disabled={busy} onClick={() => void answer("always")} variant="outline">
        Always allow
      </Button>
      <Button disabled={busy} onClick={() => void answer("session")}>
        Allow for this session
      </Button>
    </>
  );
}
