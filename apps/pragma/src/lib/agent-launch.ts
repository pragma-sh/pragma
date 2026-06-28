import { modelLaunchArgs } from "@/lib/agent-model-selection";
import { type AgentConfig, type AgentModelSelection, ptySpawn, ptyWrite } from "@/lib/tauri";
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS, terminalManager } from "@/lib/terminal-manager";

/** Delay before sending an agent's start command to a freshly created tab. */
const AGENT_START_DELAY_MS = 500;
/**
 * Extra delay after the start command before a prefill is pasted, giving the
 * agent's TUI time to boot and mount its input box. Best-effort: there is no
 * readiness signal from the PTY, so this mirrors {@link AGENT_START_DELAY_MS}'s
 * fixed-delay approach with a longer window for the heavier TUI launch.
 */
const DEFAULT_AGENT_PREFILL_DELAY_MS = 2500;
/**
 * Gap between pasting the prefill body and sending its submit key. The submit is
 * a **separate** PTY write so the agent's TUI commits the pasted text before the
 * Enter (or custom submit) keypress arrives — bundling them in one write makes a
 * paste-aware input box (Claude Code, Cursor Agent, …) absorb the trailing key
 * into the paste instead of submitting. The delay makes the two writes land as
 * distinct PTY reads. Best-effort, like the other fixed delays here; overridable
 * per agent via {@link AgentConfig.prefillSubmitDelayMs}.
 */
const DEFAULT_PREFILL_SUBMIT_DELAY_MS = 200;
// Bracketed-paste markers. Wrapping the prefill makes the TUI treat it as a
// single pasted block — multi-line markdown is inserted literally instead of a
// newline submitting the prompt early.
const BRACKETED_PASTE_START = "[200~";
const BRACKETED_PASTE_END = "[201~";

/** Builds the shell command that launches an agent from its `start` argv. */
export function agentStartCommand(start: string[]): string {
  if (start.length === 1) {
    return start[0]!;
  }
  return start.map(shellQuote).join(" ");
}

/** Quotes a single argv token for a POSIX shell, only when it needs it. */
function shellQuote(value: string): string {
  if (/^[\w./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Sends an agent's start command to a freshly created terminal tab, then — when
 * `prefill` is given — pastes that text into the agent's TUI input and submits
 * it. The writes are time-delayed because the shell prompt and the agent TUI
 * each need a moment to become ready and there is no readiness event to await;
 * the prefill is bracketed-pasted so multi-line input stays literal, and its
 * submit key is sent as a separate, later write (see {@link schedulePrefill}).
 */
export function startAgentInTab(
  tabId: string,
  agent: AgentConfig,
  prefill?: string,
  selection?: AgentModelSelection,
): void {
  const command = agentStartCommand([...agent.start, ...modelLaunchArgs(agent, selection)]);
  const message = prefill?.trim() ? prefill : null;
  const write = (data: string) => terminalManager.writeWhenReady(tabId, data);
  window.setTimeout(() => {
    write(`${command}\r`);
    scheduleStartupInput(agent, write);
    if (message) {
      schedulePrefill(agent, message, write);
    }
  }, AGENT_START_DELAY_MS);
}

function prefillDelayMs(agent: AgentConfig): number {
  return Math.max(0, agent.prefillDelayMs ?? DEFAULT_AGENT_PREFILL_DELAY_MS);
}

function prefillSubmitDelayMs(agent: AgentConfig): number {
  return Math.max(0, agent.prefillSubmitDelayMs ?? DEFAULT_PREFILL_SUBMIT_DELAY_MS);
}

function scheduleStartupInput(agent: AgentConfig, write: (data: string) => void): void {
  for (const input of agent.startupInput ?? []) {
    window.setTimeout(() => write(input.data), Math.max(0, input.delayMs));
  }
}

/**
 * Schedules the two-stage prefill: paste the body once the TUI has booted, then
 * send the submit key as a separate later write so the TUI commits the pasted
 * text first. Shared by foreground and background launches so both submit
 * reliably across agents.
 */
function schedulePrefill(agent: AgentConfig, message: string, write: (data: string) => void): void {
  window.setTimeout(() => {
    write(prefillBody(agent, message));
    window.setTimeout(() => write(prefillSubmit(agent)), prefillSubmitDelayMs(agent));
  }, prefillDelayMs(agent));
}

function prefillBody(agent: AgentConfig, message: string): string {
  if (agent.prefillMode === "plain") {
    return message;
  }
  return `${BRACKETED_PASTE_START}${message}${BRACKETED_PASTE_END}`;
}

function prefillSubmit(agent: AgentConfig): string {
  return agent.prefillSubmit ?? "\r";
}

// Grid the background daemon PTY starts at, before any xterm has mounted to
// fit it. A later `ptyAttach` (when the user opens the tab) re-fits it to the
// real viewport; this just needs to be large enough that the agent's TUI lays
// out reasonably while it runs unseen.
const BACKGROUND_TERMINAL_COLS = 120;
const BACKGROUND_TERMINAL_ROWS = 40;

/**
 * Launches an agent in a worktree **without** a mounted terminal: spawns the
 * daemon-backed PTY session directly (keyed by `tabId`), starts the agent, and
 * pastes `prefill` into its TUI — all over `ptyWrite`, bypassing
 * {@link terminalManager}. The daemon keeps the session alive; when the user
 * later opens the tab, `terminalManager.mount` attaches to it (replaying
 * scrollback) and finds the agent already running. Used by the Kanban board so
 * starting a card keeps the board visible.
 */
export async function startBackgroundAgentSession(
  tabId: string,
  worktreeId: string,
  cwd: string,
  agent: AgentConfig,
  prefill?: string,
  selection?: AgentModelSelection,
): Promise<void> {
  const cols = Math.min(BACKGROUND_TERMINAL_COLS, MAX_TERMINAL_COLS);
  const rows = Math.min(BACKGROUND_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
  const command = agentStartCommand([...agent.start, ...modelLaunchArgs(agent, selection)]);
  const message = prefill?.trim() ? prefill : null;

  const write = (data: string) => void ptyWrite(tabId, data);
  await ptySpawn(tabId, worktreeId, cwd, cols, rows, () => {});
  window.setTimeout(() => {
    void ptyWrite(tabId, `${command}\r`);
    scheduleStartupInput(agent, write);
    if (message) {
      schedulePrefill(agent, message, write);
    }
  }, AGENT_START_DELAY_MS);
}
