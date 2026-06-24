import { modelLaunchArgs } from "@/lib/agent-model-selection";
import { type AgentConfig, type AgentModelSelection, ptyWrite } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";

/** Delay before sending an agent's start command to a freshly created tab. */
const AGENT_START_DELAY_MS = 500;
/**
 * Extra delay after the start command before a prefill is pasted, giving the
 * agent's TUI time to boot and mount its input box. Best-effort: there is no
 * readiness signal from the PTY, so this mirrors {@link AGENT_START_DELAY_MS}'s
 * fixed-delay approach with a longer window for the heavier TUI launch.
 */
const AGENT_PREFILL_DELAY_MS = 2500;

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
 * it. Both writes are time-delayed because the shell prompt and the
 * agent TUI each need a moment to become ready and there is no readiness event
 * to await; the prefill is bracketed-pasted so multi-line input stays literal.
 */
export function startAgentInTab(
  tabId: string,
  agent: AgentConfig,
  prefill?: string,
  selection?: AgentModelSelection,
): void {
  const command = agentStartCommand([...agent.start, ...modelLaunchArgs(agent, selection)]);
  const message = prefill?.trim() ? prefill : null;
  window.setTimeout(() => {
    void ptyWrite(tabId, `${command}\r`);
    if (message) {
      window.setTimeout(() => {
        terminalManager.writeWhenReady(
          tabId,
          `${BRACKETED_PASTE_START}${message}${BRACKETED_PASTE_END}\r`,
        );
      }, AGENT_PREFILL_DELAY_MS);
    }
  }, AGENT_START_DELAY_MS);
}
