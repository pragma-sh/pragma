import { useEffect, useState } from "react";
import { CircleCheck, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/errors";
import { onAgentStatusReset, sessionRestoreStatus, type SessionRestoreSnapshot } from "@/lib/tauri";

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 10000;
const DISMISSED_KEY = "pragma.sessionRestore.dismissedBoots";
const DISMISSED_LIMIT = 20;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Cosmetic dismissal only: unavailable storage must never prevent recovery.
    return [];
  }
}

/** Shows actual host recovery (including background tabs), not ordinary reattachment. */
export function SessionRestoreDialog() {
  const [snapshots, setSnapshots] = useState<SessionRestoreSnapshot[]>([]);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let refreshAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;

    async function refresh() {
      if (disposed) return;
      if (inFlight) {
        refreshAgain = true;
        return;
      }
      clearTimeout(timer);
      inFlight = true;
      let delay = ACTIVE_POLL_MS;
      try {
        const next = await sessionRestoreStatus();
        if (disposed) return;
        setSnapshots(next);
        if (
          next.length > 0 &&
          next.every(
            (report) =>
              report.startupComplete && report.sessions.every((session) => session.complete),
          )
        ) {
          delay = IDLE_POLL_MS;
        }
      } catch (cause) {
        console.warn("Could not read session recovery progress", errorMessage(cause));
      } finally {
        inFlight = false;
        if (!disposed) {
          timer = setTimeout(() => void refresh(), refreshAgain ? 0 : delay);
          refreshAgain = false;
        }
      }
    }

    void refresh();
    void onAgentStatusReset(() => void refresh())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
        return undefined;
      })
      .catch((cause) =>
        console.warn("Could not subscribe to session recovery", errorMessage(cause)),
      );
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const visible = snapshots.filter(
    (report) => report.sessions.length > 0 && !dismissed.includes(report.bootId),
  );
  const sessions = visible.flatMap((report) =>
    report.sessions.map((session) => ({
      ...session,
      key: `${report.bootId}:${session.tabId}`,
    })),
  );
  const restoring = visible.some(
    (report) => !report.startupComplete || report.sessions.some((session) => !session.complete),
  );
  const failed = sessions.filter((session) => session.error !== null).length;
  const completed = sessions.filter((session) => session.complete).length;

  function dismiss() {
    const next = [...new Set([...dismissed, ...visible.map((report) => report.bootId)])].slice(
      -DISMISSED_LIMIT,
    );
    setDismissed(next);
    try {
      // Cosmetic acknowledgement only. The host remains the sole recovery authority.
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch (cause) {
      console.warn("Could not remember recovery dialog dismissal", errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={sessions.length > 0}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted">
            <RotateCcw className="size-5" aria-hidden="true" />
          </div>
          <DialogTitle>{restoring ? "Restoring sessions" : "Session restore complete"}</DialogTitle>
          <DialogDescription>
            Pragma is recovering agent conversations interrupted by a server restart or crash. Your
            projects, worktrees, and tabs are still here.
          </DialogDescription>
        </DialogHeader>
        <output aria-live="polite" className="text-sm text-muted-foreground">
          {completed} of {sessions.length} processed
          {failed > 0 ? ` · ${failed} could not be restored` : ""}
        </output>
        <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto" aria-label="Session recovery">
          {sessions.map((session) => (
            <li key={session.key} className="flex items-start gap-3">
              {!session.complete ? (
                <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : session.error ? (
                <CircleAlert
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <CircleCheck
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{session.title || "Agent session"}</p>
                <p className="text-xs break-words text-muted-foreground">
                  {session.error ??
                    (session.complete ? "Conversation restored" : "Resuming conversation…")}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Plain terminals reopen as fresh shells. Original prompts are not replayed.
          {failed > 0 ? " Failed restores never start a new conversation." : ""}
        </p>
        <DialogFooter>
          <Button onClick={dismiss}>{restoring ? "Continue in background" : "Done"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
