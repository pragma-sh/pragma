import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@pragma-sh/sdk";

/** One observation of the extension's own top-level session. */
export interface PiSessionObservation {
  /**
   * The session manager's own id. Present from session start, even while the
   * session file has not been written yet.
   */
  id: string;
  /**
   * The resumable locator for that session once its file is materialized, or
   * `null` while it is not. Pi reserves the file path up front but only writes
   * the file after the first assistant message, so a new session has no
   * locator for its first turn.
   */
  locator: string | null;
}

/** Best-effort reporting surface used by the Pi lifecycle state machine. */
export interface PiReporter {
  started(): Promise<void>;
  stopped(): Promise<void>;
  cleared(): Promise<void>;
  message(message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">): Promise<void>;
  /** Reports the session's display name so Pragma can rename the hosting tab. */
  sessionName(name: string): Promise<void>;
  /**
   * Reports the harness's own opaque session locator so Pragma can resume it,
   * or `null` to clear a previously reported one that is no longer current.
   */
  sessionId(id: string | null): Promise<void>;
}

/** Serializes Pi lifecycle reports and preserves stopped-after-started. */
export class PiLifecycleReporter {
  private active = false;
  private named = false;
  /** The top-level session id last observed, materialized or not. */
  private observedSessionId: string | undefined;
  /** The identity last reported: a locator, `null` for an explicit clear, or none. */
  private reportedSessionId: string | null | undefined;
  private queue = Promise.resolve();

  constructor(private readonly reporter: PiReporter) {}

  clear(): Promise<void> {
    this.active = false;
    // A cleared session (fresh TUI or shutdown) may be a new session; let the
    // next prompt name it again.
    this.named = false;
    // Identity state is deliberately kept: a status clear or a shutdown is not
    // an observation that the stored conversation changed, so it must never
    // drop or clear the id Pragma knows. A later switch is detected by its own
    // session observation.
    return this.enqueue(() => this.reporter.cleared());
  }

  /**
   * Reports the top-level session's identity from one observation.
   *
   * Only the last observed session id and the last reported identity are
   * remembered, so a transition back to a previously seen session (A→B→A)
   * reports again while repeating the same observation never reports twice.
   * A switch to a session whose file is not written yet reports `null`, which
   * clears the conversation Pragma would otherwise restore — the previous
   * session is no longer the one running in this tab. Observing the *same*
   * session without finding its file never clears a known id, and once that
   * session's file materializes its id is reported.
   */
  identifySession(observation: PiSessionObservation): Promise<void> {
    const changed = observation.id !== this.observedSessionId;
    this.observedSessionId = observation.id;

    if (observation.locator) {
      if (!changed && observation.locator === this.reportedSessionId) {
        return this.queue;
      }
      this.reportedSessionId = observation.locator;
      return this.enqueue(() => this.reporter.sessionId(observation.locator));
    }

    // No file yet: only a change of session clears a stored id, and a clear is
    // reported once until a locator is reported again.
    if (!changed || this.reportedSessionId === null) {
      return this.queue;
    }
    this.reportedSessionId = null;
    return this.enqueue(() => this.reporter.sessionId(null));
  }

  /**
   * Reports Pi's own session name when it sets one — a rename, or a resumed
   * session that already carries a name. A native name wins over the
   * first-prompt fallback; clearing it lets the next prompt name the session.
   */
  nameSession(name: string | undefined): Promise<void> {
    const trimmed = name?.trim();
    if (!trimmed) {
      this.named = false;
      return this.queue;
    }
    this.named = true;
    return this.enqueue(() => this.reporter.sessionName(trimmed));
  }

  /**
   * Names the session after its first prompt (Pi exposes no session title of
   * its own). Later sessions in the same tab rename on their first prompt.
   */
  nameSessionFromPrompt(prompt: string): Promise<void> {
    const name = sessionNameFromPrompt(prompt);
    if (this.named || !name) {
      return this.queue;
    }
    this.named = true;
    return this.enqueue(() => this.reporter.sessionName(name));
  }

  start(): Promise<void> {
    if (this.active) return this.queue;
    this.active = true;
    return this.enqueue(() => this.reporter.started());
  }

  end(event: AgentEndEvent): Promise<void> {
    if (!this.active) return this.queue;
    this.active = false;
    return this.enqueue(() =>
      event.messages.some(isAbortedAssistantMessage)
        ? this.reporter.cleared()
        : this.reporter.stopped(),
    );
  }

  sendMessage(message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">): Promise<void> {
    return this.enqueue(() => this.reporter.message(message));
  }

  private enqueue(report: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(report, report);
    return this.queue;
  }
}

/** First line of the prompt, trimmed and capped for use as a tab title. */
export function sessionNameFromPrompt(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

function isAbortedAssistantMessage(message: AgentEndEvent["messages"][number]): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}
