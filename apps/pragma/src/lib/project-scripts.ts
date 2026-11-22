import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import { runProjectScripts } from "@/lib/tauri";

/**
 * How long the selection must rest on a project before its `switch` scripts
 * run, so cycling through projects with ⌃1…9 or a swipe runs them once, for
 * the project the user stopped on, rather than for every one passed through.
 */
export const PROJECT_SWITCH_SETTLE_MS = 400;

/**
 * Projects added this session whose first selection must not count as a
 * switch: the `add` scripts already run for them, and running `switch` beside
 * them would race the setup they do.
 */
const justAdded = new Set<string>();

/** Marks a project as just added, so selecting it does not run `switch`. */
export function markProjectAdded(projectId: string): void {
  justAdded.add(projectId);
}

/** Whether `projectId` was just added; consumes the mark. */
export function consumeProjectAdded(projectId: string): boolean {
  return justAdded.delete(projectId);
}

/** Longest command text a failure toast shows before eliding the rest. */
const SUMMARY_COMMAND_CHARS = 60;

/**
 * The part of a script failure worth a toast: one line per failed command,
 * shortened, without the header the toast title already says or each
 * command's full stdout/stderr. The full message stays one click away
 * through the toast's copy action.
 */
export function scriptFailureSummary(message: string): string {
  const [summary = message] = message.split("\nCommand: ");
  const failures = summary
    .split("\n")
    .map((line) => /^\d+\. (.*) exited (.+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map(([, command = "", status]) => `${elide(command)} exited ${status}`);
  return failures.length > 0 ? failures.join("\n") : summary.trim();
}

function elide(text: string): string {
  return text.length > SUMMARY_COMMAND_CHARS
    ? `${text.slice(0, SUMMARY_COMMAND_CHARS - 1)}…`
    : text;
}

/**
 * How long a script-failure toast stays up. Sonner's default (~4s) is gone
 * before anyone has read which command failed, let alone copied its output.
 */
const SCRIPT_FAILURE_TOAST_MS = 15_000;

interface ToastButton {
  label: string;
  onClick: () => void;
}

/**
 * A failed lifecycle run: an error unless the hook only ever warns. A toast
 * that asks for a decision stays until the user takes it or closes the toast.
 */
function failureToast(
  title: string,
  cause: unknown,
  options: { warnOnly?: boolean; decision?: ToastButton } = {},
) {
  const message = errorMessage(cause);
  const notify = options.warnOnly ? toast.warning : toast.error;
  notify(title, {
    description: scriptFailureSummary(message),
    duration: options.decision ? Number.POSITIVE_INFINITY : SCRIPT_FAILURE_TOAST_MS,
    // One action only: a second button squeezes the description into a
    // column too narrow to read. Declining a decision is the close button.
    closeButton: options.decision !== undefined,
    action: options.decision ?? {
      label: "Copy output",
      onClick: () => void navigator.clipboard.writeText(message),
    },
  });
}

/** Runs a newly added project's `add` scripts in the background. */
export async function runProjectAddScripts(projectId: string, name: string): Promise<void> {
  try {
    if (await runProjectScripts(projectId, "add")) {
      toast.success(`Project scripts finished for ${name}`);
    }
  } catch (cause) {
    failureToast(`Project add scripts failed for ${name}`, cause);
  }
}

/** Runs a project's `switch` scripts in the background; a failure only warns. */
export async function runProjectSwitchScripts(
  projectId: string,
  previousProjectId: string,
): Promise<void> {
  try {
    await runProjectScripts(projectId, "switch", previousProjectId);
  } catch (cause) {
    failureToast("Project switch scripts failed", cause, { warnOnly: true });
  }
}

/**
 * Runs a project's `remove` scripts before it is removed. Resolves whether the
 * removal may go ahead; on a failure the toast offers `removeAnyway`.
 */
export async function runProjectRemoveScripts(
  projectId: string,
  removeAnyway: () => void,
): Promise<boolean> {
  try {
    await runProjectScripts(projectId, "remove");
    return true;
  } catch (cause) {
    failureToast("Project remove scripts failed", cause, {
      decision: { label: "Remove anyway", onClick: removeAnyway },
    });
    return false;
  }
}
