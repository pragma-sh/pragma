import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@pragma/sdk";

/** Best-effort reporting surface used by the Pi lifecycle state machine. */
export interface PiReporter {
  started(): Promise<void>;
  stopped(): Promise<void>;
  cleared(): Promise<void>;
  message(message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId">): Promise<void>;
}

/** Serializes Pi lifecycle reports and preserves stopped-after-started. */
export class PiLifecycleReporter {
  private active = false;
  private queue = Promise.resolve();

  constructor(private readonly reporter: PiReporter) {}

  clear(): Promise<void> {
    this.active = false;
    return this.enqueue(() => this.reporter.cleared());
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

function isAbortedAssistantMessage(message: AgentEndEvent["messages"][number]): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}
