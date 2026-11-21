// The hook state machine: one agy hook event in, the `pragma-cli agent …`
// invocations it implies out. Pure (no I/O) so every lifecycle rule is unit
// tested; `main.ts` supplies the payload, the persisted state, and the
// transcript reader, then runs the commands.
//
// agy's lifecycle, as observed on agy 1.5.13 (see AGENTS.md for the probes):
//
//   * There is no prompt-submit hook. `PreInvocation` fires before every model
//     call, and `invocationNum` restarts at 0 for every user turn, so
//     `PreInvocation` #0 is the turn start.
//   * `Stop` fires once per finished turn with a `terminationReason`.
//     `USER_CANCELED` / `ERROR` are not completions.
//   * An Esc interrupt and a denied approval fire NO hook at all; the Pragma
//     watcher clears those from the TUI (`src/screen.ts`).
//   * Sub-agents (`invoke_subagent`) run as separate conversations whose hooks
//     carry their own `conversationId` and an empty `lastUserInput`, each with
//     its own `SessionStart` ... `Stop`.
//   * `ask_question` reaches `PreToolUse` with its full question payload, and
//     `PostToolUse` once it is answered or skipped.

import { asRecord, asText } from "../json";

/** The single agent id every report uses: the plugin's local `defineAgent` id. */
const AGENT_ID = "antigravity";

/** Stop reasons that mean the turn did not complete normally. */
const CLEARING_STOP_REASONS = new Set(["USER_CANCELED", "ERROR"]);

/** agy prefixes the option it suggests with this marker; Pragma shows the bare label. */
const RECOMMENDED_PREFIX = /^\(Recommended\)\s*/i;

/** Longest tab title derived from a prompt. */
const SESSION_NAME_MAX = 48;

/** Per-tab state persisted between hook processes. */
export interface HookState {
  /** The user conversation this tab is running; sub-agents are tracked apart. */
  parent: string | null;
  /** True between a turn's start and its stop/clear. */
  turnActive: boolean;
  /** Stable id for the active turn's messages (`<conversation>-<userStep>`). */
  turnId: string | null;
  /** Sub-agent conversations started during the active turn and not yet stopped. */
  subagents: string[];
  /** The parent stopped while sub-agents still ran; finish when the last one stops. */
  idlePending: boolean;
  /** Harness session id last reported, so a switch reports once. */
  reportedSession: string | null;
  /** Conversation the tab was last named for. */
  namedConversation: string | null;
  /** Characters already streamed per assistant message id. */
  sent: Record<string, number>;
}

/** The newest user turn as read from the transcript. */
export interface TurnReading {
  userStep: number;
  prompt: string | null;
  assistantText: string;
}

/** Everything one hook invocation needs. */
export interface HookInput {
  event: string;
  payload: Record<string, unknown>;
  state: HookState;
  tab: string;
  /** Reads the transcript at `payload.transcriptPath`; null when unreadable. */
  readTurn: (path: string) => TurnReading | null;
  /** Unix milliseconds. */
  now: number;
}

/** The new state plus the `pragma-cli agent` argv lists to run, in order. */
export interface HookOutput {
  state: HookState;
  commands: string[][];
}

/** A fresh tab with nothing tracked. */
export function emptyState(): HookState {
  return {
    parent: null,
    turnActive: false,
    turnId: null,
    subagents: [],
    idlePending: false,
    reportedSession: null,
    namedConversation: null,
    sent: {},
  };
}

/** Applies one hook event. */
export function handleHook(input: HookInput): HookOutput {
  const run = new Run(input);
  run.dispatch();
  return { state: run.state, commands: run.commands };
}

class Run {
  readonly state: HookState;
  readonly commands: string[][] = [];
  private readonly conversation: string;
  private readonly sub: boolean;

  constructor(private readonly input: HookInput) {
    this.state = structuredClone(input.state);
    this.conversation = asText(input.payload.conversationId) ?? "";
    const userInput = asText(input.payload.lastUserInput) ?? "";
    this.sub =
      this.state.subagents.includes(this.conversation) ||
      (userInput.trim() === "" &&
        this.state.parent !== null &&
        this.conversation !== this.state.parent);
  }

  dispatch(): void {
    switch (this.input.event) {
      case "SessionStart":
        return this.sessionStart();
      case "PreInvocation":
        return this.preInvocation();
      case "PostInvocation":
        return this.postInvocation();
      case "PreToolUse":
        return this.preToolUse();
      case "PostToolUse":
        return this.postToolUse();
      case "Stop":
        return this.stop();
      default:
        return undefined;
    }
  }

  private sessionStart(): void {
    if (this.sub) {
      this.trackSubagent();
      return;
    }
    this.noteParent();
    // A new user conversation (startup, `/clear`, resume) resets any stale
    // status left by a previous one. It fires right before the turn's first
    // `PreInvocation`, which reports `started` straight after.
    if (!this.state.turnActive) this.report(["cleared"]);
  }

  private preInvocation(): void {
    if (this.sub) {
      this.trackSubagent();
      return;
    }
    const first = num(this.input.payload.invocationNum) === 0;
    if (first || !this.state.turnActive) {
      this.startTurn();
      return;
    }
    // Every later model call is a heartbeat: it drops a resolved attention
    // (an answered question, an approved command) back to running.
    this.report(["started"]);
  }

  private postInvocation(): void {
    if (!this.sub && this.state.turnActive) this.syncAssistant();
  }

  private preToolUse(): void {
    const call = asRecord(this.input.payload.toolCall);
    const name = asText(call?.name) ?? "";
    if (name === "ask_question") {
      this.question(call);
      return;
    }
    if (this.sub || !this.state.turnActive) return;
    this.report(["started"]);
    this.message("tool", toolSummary(name, asRecord(call?.args)));
  }

  private postToolUse(): void {
    if (!this.state.turnActive) return;
    const name = asText(asRecord(this.input.payload.toolCall)?.name) ?? "";
    // A command approved in agy's prompt (or remotely through the watcher)
    // only becomes visible here, once it ran; re-assert running.
    if (name === "ask_question" || !this.sub) this.report(["started"]);
  }

  private stop(): void {
    if (this.sub) {
      this.stopSubagent();
      return;
    }
    // A bare stop with no tracked turn must not create a phantom done dot.
    if (!this.state.turnActive) return;
    const reason = asText(this.input.payload.terminationReason) ?? "";
    if (CLEARING_STOP_REASONS.has(reason)) {
      this.abandonTurn(reason);
    } else if (this.waitingOnSubagents()) {
      this.state.idlePending = true;
    } else {
      this.finishTurn();
    }
  }

  private stopSubagent(): void {
    this.state.subagents = this.state.subagents.filter((id) => id !== this.conversation);
    this.subagentMessage();
    const lastOne = this.state.subagents.length === 0;
    if (lastOne && this.state.idlePending && this.state.turnActive) this.finishTurn();
  }

  /** The parent went idle while sub-agents it started still run. */
  private waitingOnSubagents(): boolean {
    return this.state.subagents.length > 0 && this.input.payload.fullyIdle === false;
  }

  /** A cancelled or failed turn: clear, never `stopped`. */
  private abandonTurn(reason: string): void {
    this.endTurn();
    this.report(["cleared"]);
    if (reason !== "ERROR") return;
    const detail = asText(this.input.payload.error) || "unknown error";
    this.message("system", `Antigravity turn failed (${detail})`);
  }

  private startTurn(): void {
    this.noteParent();
    const turn = this.readTurn();
    this.state.turnActive = true;
    this.state.subagents = [];
    this.state.idlePending = false;
    this.state.turnId = `${this.conversation}-${turnKey(turn, this.input.now)}`;
    this.state.sent = {};
    this.report(["started"]);
    const prompt = turn?.prompt ?? asText(this.input.payload.lastUserInput);
    if (!prompt) return;
    this.message("user", prompt, `${AGENT_ID}-${this.state.turnId}-user`);
    this.nameSession(prompt);
  }

  /** Names the tab after a conversation's first prompt, once per conversation. */
  private nameSession(prompt: string): void {
    if (this.state.namedConversation === this.conversation) return;
    const name = sessionNameFrom(prompt);
    if (!name) return;
    this.report(["session-name", "--name", name]);
    this.state.namedConversation = this.conversation;
  }

  private finishTurn(): void {
    this.syncAssistant();
    this.endTurn();
    this.report(["stopped"]);
  }

  private endTurn(): void {
    this.state.turnActive = false;
    this.state.idlePending = false;
    this.state.subagents = [];
  }

  /** Records the user conversation, reporting its id when it changes. */
  private noteParent(): void {
    if (this.conversation === "") return;
    this.state.parent = this.conversation;
    if (this.state.reportedSession !== this.conversation) {
      this.report(["session-id", "--id", this.conversation]);
      this.state.reportedSession = this.conversation;
    }
  }

  private trackSubagent(): void {
    if (!this.state.turnActive || this.state.subagents.includes(this.conversation)) return;
    this.state.subagents.push(this.conversation);
    this.subagentMessage();
  }

  private subagentMessage(): void {
    const count = this.state.subagents.length;
    this.message("tool", count > 0 ? `Sub-agents running: ${count}` : "Sub-agents finished");
  }

  private question(call: Record<string, unknown> | null): void {
    const entries = questionEntries(asRecord(call?.args)?.questions);
    if (entries === null) return;
    const requestId = `${AGENT_ID}-${this.input.tab}-${asText(call?.id) ?? this.input.now}`;
    const [first] = entries;
    if (!first) return;
    // The legacy single-question fields always carry the first question, so a
    // multi-question attention still has a `question` for clients (and the
    // stream-integrity check) that read only those.
    this.report([
      "attention",
      "--kind",
      "question",
      "--question",
      first.question,
      "--options",
      JSON.stringify(first.options),
      ...(entries.length > 1 ? ["--questions", JSON.stringify(entries)] : []),
      "--request-id",
      requestId,
    ]);
    this.message("system", first.question);
  }

  private syncAssistant(): void {
    const turnId = this.state.turnId;
    if (turnId === null) return;
    const reply = this.readTurn()?.assistantText ?? "";
    const id = `${AGENT_ID}-${turnId}-assistant`;
    if (reply === "" || reply.length <= (this.state.sent[id] ?? 0)) return;
    this.message("assistant", reply, id);
    this.state.sent[id] = reply.length;
  }

  private readTurn(): TurnReading | null {
    const path = asText(this.input.payload.transcriptPath);
    return path ? this.input.readTurn(path) : null;
  }

  private report(args: string[]): void {
    this.commands.push(["report", "--agent", AGENT_ID, ...args]);
  }

  private message(role: string, body: string, id?: string): void {
    const payload = {
      id: id ?? `${AGENT_ID}-${this.input.tab}-${this.input.now}-${this.commands.length}-${role}`,
      role,
      text: body,
      subAgentsActive: this.state.subagents.length,
      ts: this.input.now,
    };
    this.commands.push(["message", "--agent", AGENT_ID, "--payload", JSON.stringify(payload)]);
  }
}

/** One question in Pragma's `AgentQuestion` wire shape. */
export interface QuestionEntry {
  question: string;
  options: Array<{ label: string }>;
}

/**
 * Converts `ask_question`'s `questions` argument. Returns null when any
 * question is multi-select: Pragma's answer path selects one row per question,
 * so those stay on agy's native prompt rather than being answered wrongly.
 */
export function questionEntries(value: unknown): QuestionEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: QuestionEntry[] = [];
  for (const item of value) {
    const question = asRecord(item);
    const prompt = asText(question?.question)?.trim();
    if (!question || !prompt) continue;
    if (question.is_multi_select === true) return null;
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (typeof option === "string" ? option.replace(RECOMMENDED_PREFIX, "") : ""))
      .map((label) => label.trim())
      .filter((label) => label !== "")
      .map((label) => ({ label }));
    entries.push({ question: prompt, options });
  }
  return entries.length > 0 ? entries : null;
}

/** A short, human-readable summary of a tool call for the activity feed. */
function toolSummary(name: string, args: Record<string, unknown> | null): string {
  const command = asText(args?.CommandLine);
  if (command) return command;
  const summary = asText(args?.toolSummary);
  if (summary) return `${name} ${summary}`;
  return name || "Antigravity tool call";
}

/** Tab-title-sized name from a prompt: its first nonblank line. */
export function sessionNameFrom(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "";
  return line.length <= SESSION_NAME_MAX
    ? line
    : `${line.slice(0, SESSION_NAME_MAX - 1).trimEnd()}…`;
}

/** The turn's user step when the transcript has one, else the clock. */
function turnKey(turn: TurnReading | null, now: number): number {
  const step = turn?.userStep ?? -1;
  return step >= 0 ? step : now;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
