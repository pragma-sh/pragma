import { createPragmaOpencodeHooks, type PragmaReporter } from "../hooks";

type LegacyHooks = ReturnType<typeof createPragmaOpencodeHooks>;

/**
 * One root session's latest report. `report` re-sends it as it was first
 * raised, so an approval or question keeps its original request id.
 */
interface Status {
  key: "started" | "stopped" | "attention" | "cleared";
  report: () => Promise<void>;
}

/** The root sessions one TUI shows, each with its own state machine, and the single status their tab reports. */
export interface SessionStatuses {
  /** The state machine for one root session, created on its first event. */
  hooksFor(root: string): LegacyHooks;
  /** Every root session's state machine. */
  all(): LegacyHooks[];
  /** Drops the roots `keep` rejects, removing their part of the tab's status. */
  release(keep: (root: string) => boolean): Promise<void>;
  /** The TUI is exiting: drop every root and clear the indicator. */
  dispose(): Promise<void>;
}

/**
 * Keeps one state machine per root session, because one TUI feeds several
 * session tabs and a shared machine would let one session's completion report
 * another's still-running turn as finished. Each root reports into this
 * aggregator, which shows the most significant state across all of them:
 * attention (the most recent prompt) > started > stopped > cleared.
 */
export function createSessionStatuses(
  reporter: PragmaReporter,
  createHooks: (reporter: PragmaReporter) => LegacyHooks = createPragmaOpencodeHooks,
): SessionStatuses {
  const cleared: Status = { key: "cleared", report: () => reporter.cleared() };
  const hooks = new Map<string, LegacyHooks>();
  /** Each root's latest status, least recent first, so the last attention is the newest prompt. */
  const statuses = new Map<string, Status>();
  let shown = cleared;

  function winner(): Status {
    const all = [...statuses.values()];
    return (
      all.findLast((status) => status.key === "attention") ??
      all.find((status) => status.key === "started") ??
      all.find((status) => status.key === "stopped") ??
      cleared
    );
  }

  async function publish(): Promise<void> {
    const next = winner();
    const unchanged = next === shown || (next.key !== "attention" && next.key === shown.key);
    shown = next;
    if (!unchanged) {
      await next.report();
    }
  }

  /** The reporter one root's state machine writes through. Chat and names pass straight to the tab. */
  function reporterFor(root: string): PragmaReporter {
    const update = (status: Status | undefined): Promise<void> => {
      statuses.delete(root);
      if (status) statuses.set(root, status);
      return publish();
    };
    return {
      env: reporter.env,
      started: () => update({ key: "started", report: () => reporter.started() }),
      stopped: () => update({ key: "stopped", report: () => reporter.stopped() }),
      attention: (kind) => update({ key: "attention", report: () => reporter.attention(kind) }),
      attentionCommand: (command, requestId) =>
        update({ key: "attention", report: () => reporter.attentionCommand(command, requestId) }),
      attentionQuestion: (question, options, requestId) =>
        update({
          key: "attention",
          report: () => reporter.attentionQuestion(question, options, requestId),
        }),
      attentionQuestions: (questions, requestId) =>
        update({
          key: "attention",
          report: () => reporter.attentionQuestions(questions, requestId),
        }),
      cleared: () => update(undefined),
      message: (message) => reporter.message(message),
      sessionName: (name) => reporter.sessionName(name),
      sessionId: (id) => reporter.sessionId(id),
    };
  }

  async function release(keep: (root: string) => boolean): Promise<void> {
    for (const [root, state] of hooks) {
      if (keep(root)) continue;
      hooks.delete(root);
      // Clearing reports this root's removal; the tab keeps any other root's status.
      // oxlint-disable-next-line no-await-in-loop -- roots leave the tab in turn, one report at a time.
      await state.dispose?.();
      statuses.delete(root);
    }
    await publish();
  }

  return {
    hooksFor(root) {
      let state = hooks.get(root);
      if (!state) {
        state = createHooks(reporterFor(root));
        hooks.set(root, state);
      }
      return state;
    },
    all: () => [...hooks.values()],
    release,
    async dispose() {
      await release(() => false);
      // The TUI is exiting: clear the indicator, as v1's `dispose` does.
      await reporter.cleared();
    },
  };
}
