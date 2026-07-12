// Shared TUI watcher engine for Pragma agent plugins, loaded by the
// `pragma-watch` sidecar. A plugin declares a watcher with `createTuiWatcher`
// when its agent's remote controls (command approvals, question answers,
// interjections) must be delivered as keystrokes into the live terminal: the
// in-process host-tool plugin reports a `command`/`question` attention (which
// raises the Pragma toast / mobile answer UI), and this watcher writes the
// matching keystrokes.
//
// Type-only imports keep this module free of the `@pragma/plugin` runtime
// barrel so plugin watcher bundles stay lean.
import type { AgentStreamEvent } from "@pragma/sdk";

import type { WatcherContext, WatcherDefinition } from "@pragma/plugin";

/** Per-plugin config controlling which keystrokes answer the agent's prompts. */
export interface TuiWatcherConfig {
  /**
   * Bytes written to accept a permission prompt. Default `\r` (Enter — e.g.
   * opencode's three-option prompt has "Allow" selected first, so Enter
   * approves).
   */
  approveKeys?: string;
  /**
   * Bytes written to reject a prompt. Default two Right-arrow presses then Enter
   * (`\x1b[C\x1b[C\r`) — moves the selection to opencode's third ("Reject")
   * option and confirms it.
   */
  denyKeys?: string;
  /**
   * Bytes written after an interjection's text to submit it. Default `\r`
   * (Enter). Set to `""` to type the text without submitting.
   */
  submitKeys?: string;
}

/** How a plugin's agent wants the shared TUI watcher to behave. */
export interface TuiWatcherOptions {
  /** The `defineAgent` id this watcher attaches to. */
  agent: string;
  /**
   * True when the agent's permission / question prompts have no
   * decision-returning hook and must be answered via keystrokes (opencode).
   * False for agents whose approvals go through a blocking `await-decision`
   * hook (Claude Code, Cursor), leaving the watcher responsible only for
   * interjections.
   */
  handleDecisions: boolean;
  /**
   * Pause between typing an interjection's text and sending the submit keys,
   * for paste-aware TUIs that need to commit the text first. Default 0.
   */
  interjectSubmitDelayMs?: number;
}

const DEFAULT_APPROVE_KEYS = "\r";
const RIGHT_ARROW = "\x1b[C";
const DOWN_ARROW = "\x1b[B";
const DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
const DEFAULT_SUBMIT_KEYS = "\r";
/** Escape rejects the question prompt when not editing free-text. */
const QUESTION_REJECT_KEYS = "\x1b";
/** OpenCode's question TUI binds digits 1–9 to select+submit a single answer. */
const QUESTION_DIGIT_MAX = 9;
/** Lets the TUI mount its custom-answer editor before typing into it. */
const QUESTION_OTHER_INPUT_DELAY_MS = 150;

/** Backoff before re-subscribing after the agent event stream drops. */
const RESUBSCRIBE_DELAY_MS = 500;

/**
 * Builds a keystroke-driven watcher for one agent. The returned definition is
 * declared in the plugin's `definePlugin({ watchers })` and executed by the
 * `pragma-watch` sidecar for every launched session of that agent.
 */
export function createTuiWatcher(options: TuiWatcherOptions): WatcherDefinition<unknown> {
  const { agent, handleDecisions, interjectSubmitDelayMs = 0 } = options;
  return {
    agent,
    async watch(ctx: WatcherContext<unknown>): Promise<void> {
      const watcherContext = ctx as WatcherContext<TuiWatcherConfig>;
      const keys = resolveKeys(watcherContext.config);
      const seenRequestIds = new Set<string>();
      /** Options from the latest `question` attention, keyed by requestId. */
      const questionOptionsByRequestId = new Map<string, string[]>();

      while (!ctx.signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one live connection at a time; reconnect only after the previous stream ends.
          await consumeControlEvents(
            watcherContext,
            keys,
            handleDecisions,
            interjectSubmitDelayMs,
            seenRequestIds,
            questionOptionsByRequestId,
          );
        } catch {
          // Stream error (not an abort): fall through to re-connect below.
        }
        if (ctx.signal.aborted) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- backoff before the next reconnect is intentionally serial.
        await delay(RESUBSCRIBE_DELAY_MS, ctx.signal);
      }
    },
  };
}

interface ControlKeys {
  approveKeys: string;
  denyKeys: string;
  submitKeys: string;
}

/** Resolves the effective keystrokes from config, applying the defaults. */
function resolveKeys(config: TuiWatcherConfig | undefined): ControlKeys {
  const c = config ?? {};
  return {
    approveKeys: c.approveKeys ?? DEFAULT_APPROVE_KEYS,
    denyKeys: c.denyKeys ?? DEFAULT_DENY_KEYS,
    submitKeys: c.submitKeys ?? DEFAULT_SUBMIT_KEYS,
  };
}

/**
 * Drains one agent connection scoped to this watcher's agent + tab, applying
 * command/question verdicts (when `handleDecisions`) and interjections to the
 * live terminal. The connection is already filtered to this agent + tab, so no
 * per-event scope check is needed.
 */
async function consumeControlEvents(
  ctx: WatcherContext<TuiWatcherConfig>,
  keys: ControlKeys,
  handleDecisions: boolean,
  interjectSubmitDelayMs: number,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
): Promise<void> {
  const connection = await ctx.sdk.agents.connect({
    agent: ctx.agentId,
    tabId: ctx.session.tabId,
    worktreeId: ctx.session.worktreeId,
    signal: ctx.signal,
  });
  for await (const event of connection) {
    if (ctx.signal.aborted) {
      return;
    }
    await handleControlEvent(
      ctx,
      keys,
      handleDecisions,
      interjectSubmitDelayMs,
      seenRequestIds,
      questionOptionsByRequestId,
      event,
    );
  }
}

/** Applies one stream event: a deduped command/question verdict or an interjection. */
async function handleControlEvent(
  ctx: WatcherContext<TuiWatcherConfig>,
  keys: ControlKeys,
  handleDecisions: boolean,
  interjectSubmitDelayMs: number,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
  event: AgentStreamEvent,
): Promise<void> {
  // Remember question choices from attention reports so an AgentAnswer can be
  // turned into the matching TUI digit / free-text keystroke sequence.
  if (event.type === "agent" && handleDecisions) {
    rememberQuestionOptions(questionOptionsByRequestId, event);
    return;
  }
  if (handleDecisions && (await handleDecision(ctx, keys, seenRequestIds, event))) {
    return;
  }
  if (
    handleDecisions &&
    (await handleAnswer(ctx, seenRequestIds, questionOptionsByRequestId, event))
  ) {
    return;
  }
  if (event.type === "agentInput") {
    await handleInterjection(ctx, keys.submitKeys, interjectSubmitDelayMs, event.input.text);
  }
}

async function handleDecision(
  ctx: WatcherContext<TuiWatcherConfig>,
  keys: ControlKeys,
  seenRequestIds: Set<string>,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentDecision") return false;
  if (seenRequestIds.has(event.decision.requestId)) return true;
  seenRequestIds.add(event.decision.requestId);
  await writeKeys(ctx, event.decision.approved ? keys.approveKeys : keys.denyKeys);
  return true;
}

async function handleAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  seenRequestIds: Set<string>,
  questionOptionsByRequestId: Map<string, string[]>,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentAnswer") return false;
  const { answer } = event;
  if (seenRequestIds.has(answer.requestId)) return true;
  seenRequestIds.add(answer.requestId);
  const options = questionOptionsByRequestId.get(answer.requestId) ?? [];
  questionOptionsByRequestId.delete(answer.requestId);
  const reply = answer.answer?.trim() ?? null;
  if (!answer.dismissed && reply && !options.includes(reply)) {
    await writeFreeTextAnswer(ctx, options.length, reply);
    return true;
  }
  const strokes = questionAnswerKeys({ dismissed: answer.dismissed, reply, options });
  if (strokes) await writeKeys(ctx, strokes);
  return true;
}

async function writeFreeTextAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  optionCount: number,
  reply: string,
): Promise<void> {
  // The TUI reserves digit shortcuts for listed choices. Navigate to its virtual Other row.
  await writeKeys(ctx, openOtherEditorKeys(optionCount));
  await delay(QUESTION_OTHER_INPUT_DELAY_MS, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, `${reply}\r`);
}

async function handleInterjection(
  ctx: WatcherContext<TuiWatcherConfig>,
  submitKeys: string,
  submitDelayMs: number,
  text: string,
): Promise<void> {
  if (submitDelayMs <= 0 || !submitKeys) {
    await writeKeys(ctx, `${text}${submitKeys}`);
    return;
  }
  await writeKeys(ctx, text);
  await delay(submitDelayMs, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, submitKeys);
}

/**
 * Caches option labels for a live `question` attention so a later answer can
 * pick the matching TUI digit. Drops the cache when attention clears.
 */
function rememberQuestionOptions(
  cache: Map<string, string[]>,
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): void {
  if (
    event.status === "attention" &&
    event.attentionKind === "question" &&
    typeof event.requestId === "string" &&
    event.requestId.length > 0
  ) {
    const options = (event.options ?? [])
      .map((option) => option.label)
      .filter((option) => option.trim() !== "");
    cache.set(event.requestId, options);
  }
  // Orphaned entries (cleared/aborted without an AgentAnswer) are tiny and are
  // overwritten the next time the same requestId is reused; the answer handler
  // deletes the entry on a successful reply.
}

/**
 * Builds the question-TUI keystroke sequence for one remote answer.
 *
 * Single-select questions bind digits `1`–`9` to select+submit immediately.
 * "Type your own answer" is the virtual option after the last label. It needs
 * arrow navigation plus Enter to open its editor, then text + Enter to submit.
 * Dismiss maps to Escape. Returns `null` when there is nothing to write.
 */
export function questionAnswerKeys(input: {
  dismissed: boolean;
  reply: string | null;
  options: string[];
}): string | null {
  if (input.dismissed || input.reply === null) {
    return QUESTION_REJECT_KEYS;
  }
  const reply = input.reply.trim();
  if (!reply) {
    return QUESTION_REJECT_KEYS;
  }
  const options = input.options;
  const matchIndex = options.findIndex((option) => option === reply);
  if (matchIndex >= 0) {
    return selectOptionKeys(matchIndex, options.length);
  }
  // Free-text / "Other": open the custom-answer editor, type, submit.
  return `${openOtherEditorKeys(options.length)}${reply}\r`;
}

/** Opens the TUI's virtual custom-answer editor. */
function openOtherEditorKeys(optionCount: number): string {
  return `${DOWN_ARROW.repeat(optionCount)}\r`;
}

/**
 * Keys that highlight option `index` (0-based) and activate it. Prefer digits
 * 1–9 (the TUI's fast path); fall back to Down arrows + Enter past digit 9.
 */
function selectOptionKeys(index: number, optionCount: number): string {
  const total = optionCount + 1; // options + "Type your own answer"
  if (index < QUESTION_DIGIT_MAX && index < total) {
    return String(index + 1);
  }
  return `${DOWN_ARROW.repeat(index)}\r`;
}

/** Writes keystrokes, swallowing transient failures so the watcher survives. */
async function writeKeys(ctx: WatcherContext<TuiWatcherConfig>, data: string): Promise<void> {
  try {
    await ctx.sendKeys(data);
  } catch {
    // A transient write failure must not tear down the watcher; a later
    // verdict or interjection for this session still gets a chance to apply.
  }
}

/** Resolves after `ms`, or immediately once `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  });
}
