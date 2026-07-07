// Host-side watcher for the built-in opencode agent, loaded by the `pragma-watch`
// sidecar (see `apps/pragma/src-tauri/src/plugins.rs`). opencode exposes no
// decision-returning plugin hook on the current binary, so remote command
// approval goes the watcher route: the in-process opencode plugin reports a
// `command` attention (which raises the Pragma approval toast), and this watcher
// answers the user's verdict by writing the keystroke into the live terminal.
//
// Type-only imports keep this module free of the `@pragma/plugin` runtime barrel
// so the sidecar bundle stays a lean node module.
import type { WatcherContext, WatcherDefinition } from "@pragma/plugin";

/** Per-plugin config controlling which keystrokes answer opencode's prompt. */
export interface OpencodeWatcherConfig {
  /**
   * Bytes written to accept a permission prompt. Default `\r` (Enter — opencode's
   * three-option prompt has "Allow" selected first, so Enter approves).
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

const DEFAULT_APPROVE_KEYS = "\r";
const RIGHT_ARROW = "\x1b[C";
const DEFAULT_DENY_KEYS = `${RIGHT_ARROW}${RIGHT_ARROW}\r`;
const DEFAULT_SUBMIT_KEYS = "\r";

/** Backoff before re-subscribing after the agent event stream drops. */
const RESUBSCRIBE_DELAY_MS = 500;

/**
 * Watches one launched opencode session and drives it from the app's control
 * channel: for every command-approval verdict, write the matching keystroke into
 * the terminal; for every interjection (`AgentInput`), type the text and submit
 * it. Runs until the session exits (`ctx.signal` aborts).
 *
 * The agent event stream is a long-lived HTTP response that can drop (gateway
 * hiccup, idle close, reconnect) while opencode keeps running. A single `for
 * await` would then end and leave the session permanently unable to be driven,
 * so we re-connect until the signal aborts — a dropped stream must not silently
 * disable approval or interjection.
 */
/**
 * Builds a built-in-agent watcher. `handleDecisions` is true for opencode (whose
 * permission prompts have no decision-returning hook and so must be answered via
 * keystrokes); it is false for agents (Claude Code, Cursor) whose approvals go
 * through a blocking `await-decision` hook, leaving the watcher responsible only
 * for interjections.
 */
function createBuiltinWatcher(
  agent: string,
  handleDecisions: boolean,
): WatcherDefinition<OpencodeWatcherConfig> {
  return {
    agent,
    // fallow-ignore-next-line complexity -- polling loop with reconnect is intentionally serial; breaking up would add more complexity
    async watch(ctx: WatcherContext<OpencodeWatcherConfig>): Promise<void> {
      const config = ctx.config ?? {};
      const keys: ControlKeys = {
        approveKeys: config.approveKeys ?? DEFAULT_APPROVE_KEYS,
        denyKeys: config.denyKeys ?? DEFAULT_DENY_KEYS,
        submitKeys: config.submitKeys ?? DEFAULT_SUBMIT_KEYS,
      };
      const seenRequestIds = new Set<string>();

      while (!ctx.signal.aborted) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one live connection at a time; reconnect only after the previous stream ends.
          await consumeControlEvents(ctx, keys, handleDecisions, seenRequestIds);
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

/** Answers opencode permission prompts and applies interjections via keystrokes. */
export const opencodeApprovalWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("opencode", true);

/** Applies interjections to Claude Code; approvals go through its blocking hook. */
export const claudeCodeInterjectWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("claude-code", false);

/** Applies interjections to Cursor Agent; approvals go through its blocking hook. */
export const cursorInterjectWatcher: WatcherDefinition<OpencodeWatcherConfig> =
  createBuiltinWatcher("cursor", false);

interface ControlKeys {
  approveKeys: string;
  denyKeys: string;
  submitKeys: string;
}

/**
 * Drains one agent connection scoped to this watcher's agent + tab, applying
 * command verdicts (when `handleDecisions`) and interjections to the live
 * terminal. The connection is already filtered to this agent + tab, so no
 * per-event scope check is needed.
 */
// fallow-ignore-next-line complexity -- sequential per-event decision handling; splitting would not reduce essential complexity
async function consumeControlEvents(
  ctx: WatcherContext<OpencodeWatcherConfig>,
  keys: ControlKeys,
  handleDecisions: boolean,
  seenRequestIds: Set<string>,
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
    if (handleDecisions && event.type === "agentDecision") {
      const { decision } = event;
      if (seenRequestIds.has(decision.requestId)) {
        continue;
      }
      seenRequestIds.add(decision.requestId);
      await writeKeys(ctx, decision.approved ? keys.approveKeys : keys.denyKeys);
    } else if (event.type === "agentInput") {
      await writeKeys(ctx, `${event.input.text}${keys.submitKeys}`);
    }
  }
}

/** Writes keystrokes, swallowing transient failures so the watcher survives. */
async function writeKeys(ctx: WatcherContext<OpencodeWatcherConfig>, data: string): Promise<void> {
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

/**
 * Default export shape the `pragma-watch` sidecar loads (`default.watchers`).
 * This is the shared built-in-agent watcher bundle: the sidecar selects the
 * entry whose `agent` matches the launched agent, so opencode, Claude Code, and
 * Cursor all resolve from this one module.
 */
const pragmaWatcher: { watchers: WatcherDefinition<OpencodeWatcherConfig>[] } = {
  watchers: [opencodeApprovalWatcher, claudeCodeInterjectWatcher, cursorInterjectWatcher],
};

export default pragmaWatcher;
