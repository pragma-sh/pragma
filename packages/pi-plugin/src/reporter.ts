import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@pragma/sdk";

/** Best-effort reporting surface used by the Pi lifecycle state machine. */
export interface PiReporter {
  started(): Promise<void>;
  stopped(): Promise<void>;
  cleared(): Promise<void>;
  message(message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">): Promise<void>;
  /** Reports the session's display name so Pragma can rename the hosting tab. */
  sessionName(name: string): Promise<void>;
}

/** Serializes Pi lifecycle reports and preserves stopped-after-started. */
export class PiLifecycleReporter {
  private active = false;
  private named = false;
  private queue = Promise.resolve();

  constructor(private readonly reporter: PiReporter) {}

  clear(): Promise<void> {
    this.active = false;
    // A cleared session (fresh TUI or shutdown) may be a new session; let the
    // next prompt name it again.
    this.named = false;
    return this.enqueue(() => this.reporter.cleared());
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
