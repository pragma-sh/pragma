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
   * Handle question answers even when command decisions use a blocking hook.
   * Defaults to `handleDecisions`.
   */
  handleQuestionAnswers?: boolean;
  /**
   * Pause between typing an interjection's text and sending the submit keys,
   * for paste-aware TUIs that need to commit the text first. Defaults to a
   * short delay so paste and submit always land as separate PTY writes; a
   * single combined write is absorbed by paste-aware agents and leaves the
   * message staged instead of submitted.
   */
  interjectSubmitDelayMs?: number;
  /** How interjection text is entered. Defaults to bracketed paste. */
  interjectMode?: "bracketed" | "plain";
  /** Agent-owned keys used to submit an interjection. Defaults to config or Enter. */
  interjectSubmitKeys?: string;
  /**
   * How the question prompt's option rows are activated.
   * `"digit"` (default): the TUI binds digits `1`–`9` to select-and-submit a
   * row outright (opencode, Codex).
   * `"arrow-space"`: rows are navigated with Down, marked with Space, and only
   * then submitted with Enter (Junie's `space to select` list, which ignores
   * digits entirely). Its custom-answer row is a plain input reached by moving
   * past the last option — no Enter is needed to open it.
   */
  questionSelectMode?: QuestionSelectMode;
  /** How to enter the native free-text answer row. Defaults to Down + Enter. */
  questionOtherMode?: QuestionOtherMode;
  /** Native dismissal keys. Defaults to Escape. */
  questionDismissKeys?: string;
  /** Keys sent after all answers to confirm a separate review screen. */
  questionFinalizeKeys?: string;
}

/** How a question TUI's option rows are activated. See `questionSelectMode`. */
export type QuestionSelectMode = "digit" | "arrow-space";

/** How a question TUI activates its synthetic free-text row. */
export type QuestionOtherMode = "navigate-enter" | "navigate" | "shortcut-z";

const DEFAULT_APPROVE_KEYS = "\r";
const RIGHT_ARROW = "\x1b[C";
const DOWN_ARROW = "\x1b[B";
const DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
const DEFAULT_SUBMIT_KEYS = "\r";
/** Bracketed paste keeps newlines literal — Enter alone would submit mid-prompt. */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
/** Escape rejects the question prompt when not editing free-text. */
const QUESTION_REJECT_KEYS = "\x1b";
/** OpenCode's question TUI binds digits 1–9 to select+submit a single answer. */
const QUESTION_DIGIT_MAX = 9;
/** Lets a newly reported question prompt mount before sending any answer keys. */
const QUESTION_PROMPT_MOUNT_DELAY_MS = 150;
/** Lets the TUI mount its custom-answer editor before typing into it. */
const QUESTION_OTHER_INPUT_DELAY_MS = 150;
/** Lets the next prompt in a multi-question TUI mount after one answer submits. */
const QUESTION_NEXT_PROMPT_DELAY_MS = 500;

/** Backoff before re-subscribing after the agent event stream drops. */
const RESUBSCRIBE_DELAY_MS = 500;
/**
 * Default delay between bracketed-pasting an interjection and sending its
 * submit key. Keeps the two writes distinct for paste-aware TUIs.
 */
const DEFAULT_INTERJECT_SUBMIT_DELAY_MS = 200;

/**
 * Builds a keystroke-driven watcher for one agent. The returned definition is
 * declared in the plugin's `definePlugin({ watchers })` and executed by the
 * `pragma-watch` sidecar for every launched session of that agent.
 */
export function createTuiWatcher(options: TuiWatcherOptions): WatcherDefinition<unknown> {
  const {
    agent,
    handleDecisions,
    handleQuestionAnswers = handleDecisions,
    interjectSubmitDelayMs = DEFAULT_INTERJECT_SUBMIT_DELAY_MS,
    interjectMode = "bracketed",
    interjectSubmitKeys,
    questionSelectMode = "digit",
    questionOtherMode = "navigate-enter",
    questionDismissKeys = QUESTION_REJECT_KEYS,
    questionFinalizeKeys = "",
  } = options;
  return {
    agent,
    async watch(ctx: WatcherContext<unknown>): Promise<void> {
      const watcherContext = ctx as WatcherContext<TuiWatcherConfig>;
      const runtime: WatcherRuntime = {
        keys: resolveKeys(watcherContext.config, interjectSubmitKeys),
        handleDecisions,
        handleQuestionAnswers,
        interjectSubmitDelayMs,
        interjectMode,
        questionSelectMode,
        questionOtherMode,
        questionDismissKeys,
        questionFinalizeKeys,
        seenRequestIds: new Set<string>(),
        questionsByRequestId: new Map<string, CachedQuestion>(),
        outstandingCommandRequestId: null,
      };

      let failures = 0;
      while (!ctx.signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one live connection at a time; reconnect only after the previous stream ends.
          await consumeControlEvents(watcherContext, runtime);
          failures = 0;
        } catch (error) {
          // Stream error (not an abort): report it, then re-connect below.
          failures += 1;
          reportStreamFailure(agent, failures, error);
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

/**
 * Reports a dropped agent-event stream on stderr, which the host server
 * captures.
 *
 * Reconnecting silently is what made an unreachable gateway invisible: the
 * watcher spun on a dead address forever while a phone's replies vanished with
 * no trace anywhere. Logging is rate-limited to the first failure and then
 * every {@link STREAM_FAILURE_LOG_EVERY} consecutive ones, so a gateway that
 * stays down costs a line every few minutes rather than two per second.
 */
function reportStreamFailure(agent: string, consecutive: number, error: unknown): void {
  if (consecutive !== 1 && consecutive % STREAM_FAILURE_LOG_EVERY !== 0) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  // `console.warn`, not `process.stderr`: this bundle is also loaded by the
  // desktop webview, where `process` does not exist.
  console.warn(JSON.stringify({ type: "watcher.streamError", agent, consecutive, error: message }));
}

/** Consecutive stream failures between repeat log lines (see {@link reportStreamFailure}). */
const STREAM_FAILURE_LOG_EVERY = 240;

interface ControlKeys {
  approveKeys: string;
  denyKeys: string;
  submitKeys: string;
}

/** One question in a live (possibly multi-question) attention report. */
interface CachedQuestionEntry {
  question: string;
  options: string[];
}

/** Question metadata cached from a live `question` attention report. */
interface CachedQuestion {
  questions: CachedQuestionEntry[];
}

/** Per-session watcher state and resolved behavior shared by every handler. */
interface WatcherRuntime {
  keys: ControlKeys;
  handleDecisions: boolean;
  handleQuestionAnswers: boolean;
  interjectSubmitDelayMs: number;
  interjectMode: "bracketed" | "plain";
  questionSelectMode: QuestionSelectMode;
  questionOtherMode: QuestionOtherMode;
  questionDismissKeys: string;
  questionFinalizeKeys: string;
  seenRequestIds: Set<string>;
  questionsByRequestId: Map<string, CachedQuestion>;
  /**
   * requestId of the command attention currently pinned in this session, or
   * `null` when no command attention is outstanding. `handleDecision` applies
   * a verdict only when it matches this id — unless no command attention was
   * ever seen (mid-stream connect), in which case any verdict is accepted.
   */
  outstandingCommandRequestId: string | null;
}

/** Resolves the effective keystrokes from config, applying the defaults. */
function resolveKeys(
  config: TuiWatcherConfig | undefined,
  interjectSubmitKeys: string | undefined,
): ControlKeys {
  const c = config ?? {};
  return {
    approveKeys: c.approveKeys ?? DEFAULT_APPROVE_KEYS,
    denyKeys: c.denyKeys ?? DEFAULT_DENY_KEYS,
    submitKeys: c.submitKeys ?? interjectSubmitKeys ?? DEFAULT_SUBMIT_KEYS,
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
  runtime: WatcherRuntime,
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
    await handleControlEvent(ctx, runtime, event);
  }
}

/** Applies one stream event: a deduped command/question verdict or an interjection. */
async function handleControlEvent(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  event: AgentStreamEvent,
): Promise<void> {
  // Remember question text/choices from attention reports so an AgentAnswer
  // can be turned into the matching TUI digit / free-text keystroke sequence.
  // The outstanding command attention's requestId is tracked so a verdict can
  // be matched to its prompt (see `handleDecision`).
  if (event.type === "agent") {
    if (runtime.handleQuestionAnswers) rememberQuestion(runtime.questionsByRequestId, event);
    if (runtime.handleDecisions) rememberCommandAttention(runtime, event);
    return;
  }
  if (runtime.handleDecisions && (await handleDecision(ctx, runtime, event))) {
    return;
  }
  if (runtime.handleQuestionAnswers && (await handleAnswer(ctx, runtime, event))) {
    return;
  }
  if (event.type === "agentInput") {
    await handleInterjection(
      ctx,
      runtime.keys.submitKeys,
      runtime.interjectSubmitDelayMs,
      runtime.interjectMode,
      event.input.text,
    );
  }
}

/**
 * Applies a command-approval verdict by writing the approve/deny keystrokes.
 *
 * The verdict must match the requestId of the command attention currently
 * outstanding in this session; a mismatched id is a stray/wrong verdict and is
 * ignored (the paired `command` attention stays pinned). The one exception is
 * when no command attention has been seen at all: a watcher can connect
 * mid-stream after the attention was raised, or reconnect once the attention
 * snapshot has already been superseded, while the verdict still arrives live
 * or via the replay buffer — dropping that verdict would leave the agent stuck
 * at the approval dialog. `seenRequestIds` dedupes verdicts replayed across
 * reconnects (including rejected strays, so they cannot apply later once a new
 * attention is outstanding), and the connection is already scoped to this
 * agent + tab, so every `agentDecision` here is a verdict for this session.
 */
async function handleDecision(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentDecision") return false;
  if (runtime.seenRequestIds.has(event.decision.requestId)) return true;
  runtime.seenRequestIds.add(event.decision.requestId);
  // A verdict whose requestId matches no outstanding command attention is a
  // stray/wrong verdict for this session — except when no command attention
  // was ever seen: the watcher may have connected mid-stream after the
  // attention was raised (or its snapshot was already superseded), so the
  // verdict must still apply or the agent stays stuck at the approval dialog.
  // Recording the rejected id in `seenRequestIds` keeps a replay of the same
  // stray verdict from being applied later once a new attention is outstanding.
  if (
    runtime.outstandingCommandRequestId !== null &&
    runtime.outstandingCommandRequestId !== event.decision.requestId
  ) {
    return true;
  }
  runtime.outstandingCommandRequestId = null;
  await writeKeys(ctx, event.decision.approved ? runtime.keys.approveKeys : runtime.keys.denyKeys);
  return true;
}

// fallow-ignore-next-line complexity -- correlates answer lifecycle with TUI-specific delivery modes.
async function handleAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentAnswer") return false;
  const { answer } = event;
  const cached = runtime.questionsByRequestId.get(answer.requestId);
  if (!cached) return true;
  if (runtime.seenRequestIds.has(answer.requestId)) return true;
  runtime.seenRequestIds.add(answer.requestId);
  runtime.questionsByRequestId.delete(answer.requestId);
  await delay(QUESTION_PROMPT_MOUNT_DELAY_MS, ctx.signal);
  if (ctx.signal.aborted) return true;
  const reply = answer.answer?.trim() ?? null;
  if (cached.questions.length > 1) {
    if (!answer.dismissed && reply) {
      await writeMultipleQuestionAnswers(ctx, runtime, cached.questions, reply);
    } else if (answer.dismissed || !reply) {
      await writeKeys(ctx, runtime.questionDismissKeys);
    }
    return true;
  }
  const single = cached.questions[0] ?? { question: "", options: [] };
  await writeQuestionAnswer(ctx, runtime, single, reply, answer.dismissed);
  if (!answer.dismissed && reply) await finalizeQuestionAnswers(ctx, runtime);
  return true;
}

async function writeQuestionAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  question: CachedQuestionEntry,
  reply: string | null,
  dismissed: boolean,
): Promise<void> {
  if (dismissed || !reply) {
    await writeKeys(ctx, runtime.questionDismissKeys);
    return;
  }
  if (!dismissed && reply && !question.options.includes(reply)) {
    await writeFreeTextAnswer(
      ctx,
      question.options.length,
      reply,
      runtime.questionSelectMode,
      runtime.questionOtherMode,
    );
    return;
  }
  const strokes = questionAnswerKeys({
    dismissed,
    reply,
    options: question.options,
    selectMode: runtime.questionSelectMode,
  });
  if (strokes) await writeKeys(ctx, strokes);
}

async function writeFreeTextAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  optionCount: number,
  reply: string,
  selectMode: QuestionSelectMode,
  otherMode: QuestionOtherMode,
): Promise<void> {
  // The TUI reserves digit shortcuts for listed choices. Navigate to its virtual Other row.
  await writeKeys(ctx, openOtherEditorKeys(optionCount, selectMode, otherMode));
  await delay(QUESTION_OTHER_INPUT_DELAY_MS, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, `${reply}\r`);
}

/**
 * Multi-question delivery. Clients submit every answer on one ` | `-separated
 * line. Apply each answer to its corresponding native TUI prompt in order.
 */
async function writeMultipleQuestionAnswers(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  questions: CachedQuestionEntry[],
  combined: string,
): Promise<void> {
  const replies = combined.split(" | ").map((reply) => reply.trim());
  for (const [index, question] of questions.entries()) {
    const reply = replies[index];
    if (!reply || ctx.signal.aborted) return;
    // oxlint-disable-next-line no-await-in-loop -- prompts must be answered in TUI order.
    await writeQuestionAnswer(ctx, runtime, question, reply, false);
    if (index < questions.length - 1) {
      // oxlint-disable-next-line no-await-in-loop -- next prompt mounts only after current answer.
      await delay(QUESTION_NEXT_PROMPT_DELAY_MS, ctx.signal);
    }
  }
  await finalizeQuestionAnswers(ctx, runtime);
}

async function finalizeQuestionAnswers(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
): Promise<void> {
  if (!runtime.questionFinalizeKeys || ctx.signal.aborted) return;
  await delay(QUESTION_NEXT_PROMPT_DELAY_MS, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, runtime.questionFinalizeKeys);
}

/**
 * Types an interjection into the live terminal, then submits it.
 *
 * Text is always bracketed-pasted so embedded newlines (scratchpad comment
 * handoffs, multi-line chat) stay literal — a bare `\n` would submit mid-prompt
 * in every TUI that treats Enter as send. Submit keys always travel in a
 * separate write after `submitDelayMs`, matching paste-aware agents.
 */
async function handleInterjection(
  ctx: WatcherContext<TuiWatcherConfig>,
  submitKeys: string,
  submitDelayMs: number,
  mode: "bracketed" | "plain",
  text: string,
): Promise<void> {
  const input = mode === "plain" ? text : `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
  await writeKeys(ctx, input);
  if (!submitKeys) {
    return;
  }
  await delay(submitDelayMs, ctx.signal);
  if (!ctx.signal.aborted) await writeKeys(ctx, submitKeys);
}

/**
 * Tracks the requestId of the command attention currently pinned in this
 * session. A `command` attention report pins its id; any other status
 * (running/done/cleared) means the prompt resolved, so the outstanding id is
 * released and the next verdict must match a fresh attention instead.
 */
function rememberCommandAttention(
  runtime: WatcherRuntime,
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): void {
  if (
    event.status === "attention" &&
    event.attentionKind === "command" &&
    typeof event.requestId === "string" &&
    event.requestId.length > 0
  ) {
    runtime.outstandingCommandRequestId = event.requestId;
    return;
  }
  if (event.status !== "attention") {
    runtime.outstandingCommandRequestId = null;
  }
}

/**
 * Caches question text and option labels for a live `question` attention so a
 * later answer can pick the matching native TUI option or editor.
 */
function rememberQuestion(
  cache: Map<string, CachedQuestion>,
  event: Extract<AgentStreamEvent, { type: "agent" }>,
): void {
  if (
    event.status === "attention" &&
    event.attentionKind === "question" &&
    typeof event.requestId === "string" &&
    event.requestId.length > 0
  ) {
    const entries = (event.questions ?? []).flatMap(questionEntry);
    if (entries.length > 0) {
      cache.set(event.requestId, { questions: entries });
      return;
    }
    const options = (event.options ?? [])
      .map((option) => option.label)
      .filter((option) => option.trim() !== "");
    cache.set(event.requestId, {
      questions: [{ question: event.question ?? "", options }],
    });
  }
  // Orphaned entries (cleared/aborted without an AgentAnswer) are tiny and are
  // overwritten the next time the same requestId is reused; the answer handler
  // deletes the entry on a successful reply.
}

function questionEntry(value: unknown): CachedQuestionEntry[] {
  if (typeof value !== "object" || value === null || !("question" in value)) {
    return [];
  }
  const record = value as { question?: unknown; options?: unknown };
  if (typeof record.question !== "string" || !record.question.trim()) {
    return [];
  }
  const options = Array.isArray(record.options)
    ? record.options
        .filter(
          (option): option is { label?: unknown } => Boolean(option) && typeof option === "object",
        )
        .map((option) => option.label)
        .filter((label): label is string => typeof label === "string" && label.trim() !== "")
    : [];
  return [{ question: record.question, options }];
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
  selectMode?: QuestionSelectMode;
}): string | null {
  if (input.dismissed || input.reply === null) {
    return QUESTION_REJECT_KEYS;
  }
  const reply = input.reply.trim();
  if (!reply) {
    return QUESTION_REJECT_KEYS;
  }
  const options = input.options;
  const selectMode = input.selectMode ?? "digit";
  const matchIndex = options.findIndex((option) => option === reply);
  if (matchIndex >= 0) {
    return selectOptionKeys(matchIndex, options.length, selectMode);
  }
  // Free-text / "Other": open the custom-answer editor, type, submit.
  return `${openOtherEditorKeys(options.length, selectMode, "navigate-enter")}${reply}\r`;
}

/**
 * Opens the TUI's virtual custom-answer editor. `arrow-space` lists put a plain
 * input past the last option, so moving onto it is enough — an Enter there would
 * submit the empty answer instead.
 */
function openOtherEditorKeys(
  optionCount: number,
  selectMode: QuestionSelectMode,
  otherMode: QuestionOtherMode,
): string {
  if (otherMode === "shortcut-z") return "z";
  const navigate = DOWN_ARROW.repeat(optionCount);
  return selectMode === "arrow-space" || otherMode === "navigate" ? navigate : `${navigate}\r`;
}

/**
 * Keys that highlight option `index` (0-based) and activate it. Prefer digits
 * 1–9 (the TUI's fast path); fall back to Down arrows + Enter past digit 9.
 */
function selectOptionKeys(
  index: number,
  optionCount: number,
  selectMode: QuestionSelectMode,
): string {
  if (selectMode === "arrow-space") {
    // Down to the row, Space to mark it, Enter to submit the marked answer.
    return `${DOWN_ARROW.repeat(index)} \r`;
  }
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
