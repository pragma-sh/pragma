import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  constants,
  type AgentMessage,
  type AgentProgressEstimate,
  type AgentStatus,
} from "@pragma-sh/constants";

import { reportingAgentName } from "@/lib/agent-lookup";
import { system1AgentProgress, type AgentProgressInput } from "@/lib/tauri";
import { listPluginAgents } from "@/plugins/agents";
import {
  agentStatusSnapshot,
  allAgentMessages,
  subscribeAgentMessageEvents,
  subscribeAgentStatuses,
  type AgentStatusEntry,
} from "@/state/agent-status-store";
import { useSystem1Status } from "@/state/system1";

/**
 * Sidebar agent progress, estimated by the configured System 1 model.
 *
 * After every new message an agent writes on the rich message stream (the one
 * Pragma Go renders as chat), the tracker asks System 1 — through the
 * `system1_agent_progress` command, so the key never leaves Rust — how far the
 * agent is through its task and what it is doing now. It sends the task prompt
 * (the first user message) and the agent's latest reply.
 *
 * Pragma owns this, not the agent plugins: every agent that reports messages
 * gets progress for free. Requests are debounced per agent, at most one is in
 * flight per agent (a message that lands meanwhile re-runs it once afterwards),
 * and a failure pauses estimation for `errorBackoffMs` so a bad key is not
 * retried on every message.
 */

/** One estimate, stamped with when it arrived. */
export interface AgentProgress extends AgentProgressEstimate {
  updatedAt: number;
}

/** What the tracker remembers of one agent's transcript. */
interface Transcript {
  firstPrompt: string | null;
  latestPrompt: string | null;
  lastReply: string | null;
  recentTools: string[];
}

/** Tool names kept per agent, newest last. */
const RECENT_TOOL_LIMIT = 5;

const progressByKey = new Map<string, AgentProgress>();
const listeners = new Set<() => void>();

/** Stable key for one agent in one tab. */
function agentProgressKey(worktreeId: string, tabId: string, agent: string): string {
  return `${worktreeId}\0${tabId}\0${agent}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setProgress(key: string, progress: AgentProgress | null): void {
  if (progress) progressByKey.set(key, progress);
  else if (!progressByKey.delete(key)) return;
  notify();
}

/** React hook for one agent's latest estimate, or null when there is none. */
export function useAgentProgress(
  worktreeId: string,
  tabId: string,
  agent: string,
): AgentProgress | null {
  const key = agentProgressKey(worktreeId, tabId, agent);
  return useSyncExternalStore(
    subscribe,
    () => progressByKey.get(key) ?? null,
    () => null,
  );
}

/** The sidebar label for an activity id, e.g. `coding` → `Coding`. */
export function agentActivityLabel(activity: string): string {
  return (
    constants.system1.agentProgress.activities.find((option) => option.id === activity)?.label ??
    activity
  );
}

/** Collaborators the tracker needs; injected so tests drive it without Tauri. */
export interface AgentProgressTrackerDeps {
  estimate: (input: AgentProgressInput) => Promise<AgentProgressEstimate>;
  /** The live status of one agent key, or null when it has none. */
  statusOf: (key: string) => AgentStatus | null;
  agentName: (agent: string) => string;
  debounceMs: number;
  errorBackoffMs: number;
  now?: () => number;
}

/** Statuses an estimate is worth asking for: the agent is mid-task. */
function isActive(status: AgentStatus | null): boolean {
  return status === "running" || status === "attention";
}

function textOf(message: AgentMessage): string {
  return message.text?.trim() ?? "";
}

function emptyTranscript(): Transcript {
  return { firstPrompt: null, latestPrompt: null, lastReply: null, recentTools: [] };
}

/** A user message: the first one is the task, a later one is a follow-up. */
function recordPrompt(transcript: Transcript, text: string): void {
  if (!text) return;
  transcript.firstPrompt ??= text;
  transcript.latestPrompt = text;
}

/** An agent-authored message: its reply text and the tools it called. */
function recordAgentOutput(transcript: Transcript, message: AgentMessage): void {
  const text = textOf(message);
  if (message.role === "assistant" && text) transcript.lastReply = text;
  const tools = (message.toolCalls ?? []).map((call) => call.name);
  if (tools.length > 0) {
    transcript.recentTools = [...transcript.recentTools, ...tools].slice(-RECENT_TOOL_LIMIT);
  }
}

/** The latest user prompt, when it is not the task prompt itself. */
function followUpOf(transcript: Transcript): string | null {
  const latest = transcript.latestPrompt;
  return latest && latest !== transcript.firstPrompt ? latest : null;
}

/** Whether the agent has written anything an estimate could be based on. */
function hasAgentOutput(transcript: Transcript): boolean {
  return transcript.lastReply !== null || transcript.recentTools.length > 0;
}

/** Live statuses keyed like the tracker's transcripts. */
function statusesByKey(entries: readonly AgentStatusEntry[]): Map<string, AgentStatus> {
  return new Map(
    entries.map((entry) => [
      agentProgressKey(entry.worktreeId, entry.tabId, entry.agent),
      entry.status,
    ]),
  );
}

/** A status change that starts a new run, whose old estimate no longer applies. */
function restartedRunning(previous: AgentStatus | undefined, status: AgentStatus): boolean {
  return status === "running" && previous !== undefined && !isActive(previous);
}

/**
 * Remembers each agent's transcript and schedules estimates. Exported for
 * tests; the app runs one through {@link useAgentProgressTracking}.
 */
export class AgentProgressTracker {
  private readonly transcripts = new Map<string, Transcript>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The run generation each in-flight request was asked for. */
  private readonly inFlight = new Map<string, number>();
  /** Bumped when a key is forgotten, so a stale request cannot reach the next run. */
  private readonly generations = new Map<string, number>();
  private readonly rerun = new Set<string>();
  private readonly lastStatus = new Map<string, AgentStatus>();
  private backoffUntil = 0;
  private enabled = false;
  private disposed = false;

  constructor(private readonly deps: AgentProgressTrackerDeps) {}

  /** Turns estimation on or off; turning it on estimates every active agent. */
  // fallow-ignore-next-line unused-class-member -- called through the hook's `useRef`, which fallow does not trace.
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancelAll();
      if (progressByKey.size > 0) {
        progressByKey.clear();
        notify();
      }
      return;
    }
    for (const key of this.transcripts.keys()) {
      if (isActive(this.deps.statusOf(key))) this.schedule(key);
    }
  }

  /** Records one message; an agent-authored one schedules a fresh estimate. */
  handleMessage(message: AgentMessage): void {
    const key = agentProgressKey(message.worktreeId, message.tabId, message.agent);
    const transcript = this.transcriptFor(key);
    if (message.role === "user") {
      recordPrompt(transcript, textOf(message));
      return;
    }
    if (message.role === "system") return;
    recordAgentOutput(transcript, message);
    if (this.enabled) this.schedule(key);
  }

  /**
   * Replays stored messages when the tracker mounts. Only an agent that still
   * has a live status is mid-run; a message for one without it belongs to a
   * finished run, and replaying it would make that run's prompt the next
   * task's.
   */
  replayMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      if (this.lastStatus.has(agentProgressKey(message.worktreeId, message.tabId, message.agent))) {
        this.handleMessage(message);
      }
    }
  }

  /**
   * Reconciles with the live statuses. An agent whose status disappeared (it
   * exited, or its finished run was seen) is forgotten, so its next prompt is
   * a new task; one that starts running again drops its stale estimate.
   */
  handleStatuses(entries: readonly AgentStatusEntry[]): void {
    const live = statusesByKey(entries);
    // Deleting the entry being visited is safe while iterating a Map.
    for (const key of this.lastStatus.keys()) {
      if (!live.has(key)) this.forget(key);
    }
    for (const [key, status] of live) this.noteStatus(key, status);
  }

  /** Stops every timer; pending estimates are discarded when they land. */
  dispose(): void {
    this.disposed = true;
    this.cancelAll();
  }

  private transcriptFor(key: string): Transcript {
    let transcript = this.transcripts.get(key);
    if (!transcript) {
      transcript = emptyTranscript();
      this.transcripts.set(key, transcript);
    }
    return transcript;
  }

  private noteStatus(key: string, status: AgentStatus): void {
    const previous = this.lastStatus.get(key);
    this.lastStatus.set(key, status);
    if (!restartedRunning(previous, status)) return;
    setProgress(key, null);
    if (this.enabled && this.transcripts.has(key)) this.schedule(key);
  }

  private forget(key: string): void {
    this.lastStatus.delete(key);
    this.generations.set(key, this.generationOf(key) + 1);
    this.transcripts.delete(key);
    this.rerun.delete(key);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    setProgress(key, null);
  }

  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.rerun.clear();
  }

  private schedule(key: string): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.run(key);
      }, this.deps.debounceMs),
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private input(key: string, status: AgentStatus): AgentProgressInput | null {
    const transcript = this.transcripts.get(key);
    if (!transcript || !hasAgentOutput(transcript)) return null;
    const agent = key.split("\0")[2] ?? "";
    return {
      agent: this.deps.agentName(agent),
      status,
      prompt: transcript.firstPrompt ?? "",
      followUp: followUpOf(transcript),
      lastMessage: transcript.lastReply ?? "",
      recentTools: transcript.recentTools,
    };
  }

  /** The request to send for `key` now, or null when it should not be asked. */
  private prepare(key: string): AgentProgressInput | null {
    if (this.disposed || !this.enabled || this.now() < this.backoffUntil) return null;
    if (this.inFlight.get(key) === this.generationOf(key)) {
      // Picked up by the in-flight request's `finally`.
      this.rerun.add(key);
      return null;
    }
    const status = this.deps.statusOf(key);
    return status && isActive(status) ? this.input(key, status) : null;
  }

  private async run(key: string): Promise<void> {
    const input = this.prepare(key);
    if (!input) return;
    const generation = this.generationOf(key);
    this.inFlight.set(key, generation);
    try {
      const estimate = await this.deps.estimate(input);
      if (generation === this.generationOf(key)) this.store(key, estimate);
    } catch (cause) {
      this.backoffUntil = this.now() + this.deps.errorBackoffMs;
      console.warn("agent progress: System 1 estimate failed; pausing", cause);
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
      if (generation === this.generationOf(key) && this.rerun.delete(key)) this.schedule(key);
    }
  }

  /** Publishes an estimate unless the agent is gone or the tracker is off. */
  private store(key: string, estimate: AgentProgressEstimate): void {
    if (this.disposed || !this.enabled || !this.transcripts.has(key)) return;
    setProgress(key, { ...estimate, updatedAt: this.now() });
  }
}

/** Live status of an agent key, read from the agent-status snapshot. */
function liveStatusOf(key: string): AgentStatus | null {
  return (
    agentStatusSnapshot().find(
      (entry) => agentProgressKey(entry.worktreeId, entry.tabId, entry.agent) === key,
    )?.status ?? null
  );
}

/**
 * Runs the app's progress tracker while mounted. Estimation is on only while a
 * System 1 key is configured. Mount it once, somewhere always rendered.
 */
export function useAgentProgressTracking(): void {
  const system1 = useSystem1Status();
  const configured = system1?.configured === true;
  const tracker = useRef<AgentProgressTracker | null>(null);

  useEffect(() => {
    const settings = constants.system1.agentProgress;
    const current = new AgentProgressTracker({
      estimate: system1AgentProgress,
      statusOf: liveStatusOf,
      agentName: (agent) => reportingAgentName(listPluginAgents(), agent),
      debounceMs: settings.debounceMs,
      errorBackoffMs: settings.errorBackoffMs,
    });
    // Seed from what the store already holds: the daemon's snapshot replay may
    // have landed before this mounted.
    current.handleStatuses(agentStatusSnapshot());
    current.replayMessages(allAgentMessages());
    const stopMessages = subscribeAgentMessageEvents((message) => current.handleMessage(message));
    const stopStatuses = subscribeAgentStatuses(() =>
      current.handleStatuses(agentStatusSnapshot()),
    );
    tracker.current = current;
    return () => {
      stopMessages();
      stopStatuses();
      current.dispose();
      tracker.current = null;
    };
  }, []);

  useEffect(() => {
    tracker.current?.setEnabled(configured);
  }, [configured]);
}
