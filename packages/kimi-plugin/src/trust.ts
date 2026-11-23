/**
 * Kimi Code's folder-trust gate.
 *
 * The first launch in a folder Kimi has not seen stops on a full-screen
 * "Trust this folder?" dialog before the TUI exists. Kimi has no flag or
 * setting that skips it, no hook fires while it is up, and its preselected row
 * is "Don't trust", which exits. So a launch from Pragma sat there unanswered:
 * the prompt Pragma types next went nowhere, and a phone showed an idle agent.
 * Every new worktree is a new folder, so this was every first launch in one.
 *
 * Starting an agent in a folder is the user's decision to work there, so the
 * watcher answers the gate the way the Cursor and Antigravity plugins answer
 * theirs. Verified against Kimi Code 0.36.1.
 */

/** Moves to the "Trust this folder" row (one above the default) and selects it. */
export const KIMI_TRUST_KEYS = "\x1b[A\r";

/** Dialog text that proves the gate is on screen, lower-cased. */
const TRUST_TITLE = "trust this folder?";
/**
 * The last row the dialog draws. Waiting for it means the list is complete and
 * the cursor is on its default row before any key is sent — an arrow key sent
 * mid-render would be dropped, and the Enter after it would pick "Don't trust".
 */
const TRUST_LAST_ROW = "asked again next launch";

/** How much trailing output is kept while looking for the gate. */
const BUFFER_LIMIT = 16_384;

// oxlint-disable-next-line no-control-regex -- ANSI CSI/OSC framing uses ESC and BEL bytes.
const CONTROL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

/** Scans a session's output for the trust gate, across however it is chunked. */
export interface KimiTrustScanner {
  /** Feeds one output chunk; true exactly once, when the complete gate is first seen. */
  push: (chunk: string) => boolean;
}

/** Creates a scanner for one session. */
export function createKimiTrustScanner(): KimiTrustScanner {
  let buffer = "";
  let seen = false;
  return {
    push: (chunk) => {
      if (seen) return false;
      buffer = `${buffer}${chunk}`.slice(-BUFFER_LIMIT);
      const text = buffer.replace(CONTROL_SEQUENCE, " ").replace(/\s+/g, " ").toLowerCase();
      if (!text.includes(TRUST_TITLE) || !text.includes(TRUST_LAST_ROW)) return false;
      seen = true;
      buffer = "";
      return true;
    },
  };
}
