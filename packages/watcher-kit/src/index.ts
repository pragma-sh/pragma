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
  /**
   * Bytes written to abort the agent's in-flight response during the
   * `interject` free-text fallback. Default Escape (`\x1b`).
   */
  abortKeys?: string;
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
   * for paste-aware TUIs that need to commit the text first. Default 0.
   */
  interjectSubmitDelayMs?: number;
  /**
   * How a free-text answer that matches no listed option reaches the TUI.
   * `"editor"` (default): the question prompt has a real custom-answer editor
   * (opencode's "Type your own answer" row) — open it, type, submit.
   * `"interject"`: the prompt's generated last row is a plain fallback answer
   * with no editor (Codex's "None of the above") — select it, abort the
   * response the agent starts from that non-answer, then submit the real
   * answer as a follow-up prompt (`Answer to question "<question>": <answer>`).
   */
  questionFreeTextMode?: "editor" | "interject";
}

const DEFAULT_APPROVE_KEYS = "\r";
const RIGHT_ARROW = "\x1b[C";
const DOWN_ARROW = "\x1b[B";
const DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
const DEFAULT_SUBMIT_KEYS = "\r";
/** Escape aborts an in-flight response in the TUIs this watcher targets. */
const DEFAULT_ABORT_KEYS = "\x1b";
/** Escape rejects the question prompt when not editing free-text. */
const QUESTION_REJECT_KEYS = "\x1b";
/** OpenCode's question TUI binds digits 1–9 to select+submit a single answer. */
const QUESTION_DIGIT_MAX = 9;
/** Lets a newly reported question prompt mount before sending any answer keys. */
const QUESTION_PROMPT_MOUNT_DELAY_MS = 150;
/** Lets the TUI mount its custom-answer editor before typing into it. */
const QUESTION_OTHER_INPUT_DELAY_MS = 150;
/**
 * `interject` fallback pacing: lets the TUI resume its turn after the fallback
 * row is selected before Escape aborts it, then lets the composer settle after
 * the abort before the follow-up answer is typed.
 */
const QUESTION_FALLBACK_STEP_DELAY_MS = 500;

/** Backoff before re-subscribing after the agent event stream drops. */
const RESUBSCRIBE_DELAY_MS = 500;

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
    interjectSubmitDelayMs = 0,
    questionFreeTextMode = "editor",
  } = options;
  return {
    agent,
    async watch(ctx: WatcherContext<unknown>): Promise<void> {
      const watcherContext = ctx as WatcherContext<TuiWatcherConfig>;
      const runtime: WatcherRuntime = {
        keys: resolveKeys(watcherContext.config),
        handleDecisions,
        handleQuestionAnswers,
        interjectSubmitDelayMs,
        questionFreeTextMode,
        seenRequestIds: new Set<string>(),
        questionsByRequestId: new Map<string, CachedQuestion>(),
      };

      while (!ctx.signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one live connection at a time; reconnect only after the previous stream ends.
          await consumeControlEvents(watcherContext, runtime);
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
  abortKeys: string;
}

/** Question metadata cached from a live `question` attention report. */
interface CachedQuestion {
  question: string;
  options: string[];
}

/** Per-session watcher state and resolved behavior shared by every handler. */
interface WatcherRuntime {
  keys: ControlKeys;
  handleDecisions: boolean;
  handleQuestionAnswers: boolean;
  interjectSubmitDelayMs: number;
  questionFreeTextMode: "editor" | "interject";
  seenRequestIds: Set<string>;
  questionsByRequestId: Map<string, CachedQuestion>;
}

/** Resolves the effective keystrokes from config, applying the defaults. */
function resolveKeys(config: TuiWatcherConfig | undefined): ControlKeys {
  const c = config ?? {};
  return {
    approveKeys: c.approveKeys ?? DEFAULT_APPROVE_KEYS,
    denyKeys: c.denyKeys ?? DEFAULT_DENY_KEYS,
    submitKeys: c.submitKeys ?? DEFAULT_SUBMIT_KEYS,
    abortKeys: c.abortKeys ?? DEFAULT_ABORT_KEYS,
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
  // Command attentions carry no data the verdict handler needs, so they are not
  // cached (see `handleDecision`).
  if (event.type === "agent") {
    if (runtime.handleQuestionAnswers) rememberQuestion(runtime.questionsByRequestId, event);
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
      event.input.text,
    );
  }
}

/**
 * Applies a command-approval verdict by writing the approve/deny keystrokes.
 *
 * A verdict is self-contained (the approve/deny keys are static), so it does
 * not depend on this watcher having first seen the paired `command` attention.
 * That matters because attention delivery is not guaranteed to precede the
 * verdict for this subscriber: a watcher can connect mid-stream after the
 * attention was raised, or reconnect once the attention snapshot has already
 * been superseded, while the verdict still arrives live or via the replay
 * buffer. Gating on a remembered attention would silently drop those verdicts
 * and leave the agent stuck at the approval dialog. `seenRequestIds` dedupes
 * verdicts replayed across reconnects, and the connection is already scoped to
 * this agent + tab, so every `agentDecision` here is a verdict for this session.
 */
async function handleDecision(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  event: AgentStreamEvent,
): Promise<boolean> {
  if (event.type !== "agentDecision") return false;
  if (runtime.seenRequestIds.has(event.decision.requestId)) return true;
  runtime.seenRequestIds.add(event.decision.requestId);
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
  if (!answer.dismissed && reply && !cached.options.includes(reply)) {
    if (runtime.questionFreeTextMode === "interject") {
      await writeFallbackInterjectAnswer(ctx, runtime, cached, reply);
    } else {
      await writeFreeTextAnswer(ctx, cached.options.length, reply);
    }
    return true;
  }
  const strokes = questionAnswerKeys({
    dismissed: answer.dismissed,
    reply,
    options: cached.options,
  });
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

/**
 * Free-text delivery for TUIs whose question prompt has no custom-answer
 * editor (Codex): the virtual last row is a plain fallback answer ("None of
 * the above"). Select it to resolve the prompt, abort the response the agent
 * starts from that non-answer, then submit the real answer as a follow-up
 * prompt so the agent reads it at the start of a fresh turn.
 */
async function writeFallbackInterjectAnswer(
  ctx: WatcherContext<TuiWatcherConfig>,
  runtime: WatcherRuntime,
  cached: CachedQuestion,
  reply: string,
): Promise<void> {
  await writeKeys(ctx, openOtherEditorKeys(cached.options.length));
  await delay(QUESTION_FALLBACK_STEP_DELAY_MS, ctx.signal);
  if (ctx.signal.aborted) return;
  await writeKeys(ctx, runtime.keys.abortKeys);
  await delay(QUESTION_FALLBACK_STEP_DELAY_MS, ctx.signal);
  if (ctx.signal.aborted) return;
  await handleInterjection(
    ctx,
    runtime.keys.submitKeys,
    runtime.interjectSubmitDelayMs,
    questionFallbackMessage(cached.question, reply),
  );
}

/**
 * Builds the follow-up prompt that carries a free-text answer after the
 * `interject` fallback aborted the agent's response. Single line: the target
 * TUIs submit on Enter, so embedded newlines would send a partial message.
 */
export function questionFallbackMessage(question: string, reply: string): string {
  return `Answer to question "${flattenWhitespace(question)}": ${flattenWhitespace(reply)}`;
}

function flattenWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
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
 * Caches question text and option labels for a live `question` attention so a
 * later answer can pick the matching TUI digit or rebuild the question in the
 * `interject` fallback prompt.
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
    const options = (event.options ?? [])
      .map((option) => option.label)
      .filter((option) => option.trim() !== "");
    cache.set(event.requestId, { question: event.question ?? "", options });
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
