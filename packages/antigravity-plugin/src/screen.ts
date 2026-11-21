// Reads the three things agy shows only on screen. No hook, transcript record,
// or terminal title carries them (verified on agy 1.5.13):
//
//   * Approval prompts. agy's PreToolUse fires before its permission check and
//     cannot tell whether a prompt follows, so the prompt block itself is the
//     signal:
//
//       Requesting permission for:
//          cd /etc && rm -f /tmp/x
//
//       Run this command?
//       > 1. Yes, run command
//         …
//         4. No, cancel
//
//     agy paints that block in one contiguous write, so stripping escape
//     sequences leaves it intact. Other tools ask "Allow access to this URL?",
//     "Allow calling this tool?", and so on, under the same heading.
//   * Interrupts. Esc (and a declined approval) ends the turn with no hook and
//     no transcript record; the only trace is
//     "⎿  Interrupted · What should Antigravity CLI do instead?".
//   * The workspace-trust gate shown on first launch in a new folder.
//
// agy paints the interrupt line once, in place. The only time it reappears is
// a full-screen repaint (a clear-screen sequence, then the whole history), so
// an interrupt counts unless it arrives inside one; the next footer ("esc to
// cancel" busy, "? for shortcuts" idle) ends the repaint. Gating on the busy
// footer instead is unreliable: under load agy coalesces frames and can go
// from the submitted prompt straight to the interrupt without painting it.

/** Something the scanner recognised in agy's output. */
export type ScreenEvent =
  | { type: "approval"; command: string; question: string }
  | { type: "interrupted" }
  | { type: "trust" };

const ESCAPE_SEQUENCES =
  // CSI, OSC (BEL or ST terminated), DCS/APC/PM/SOS strings, then lone escapes.
  // oxlint-disable-next-line no-control-regex -- matching terminal control bytes is the point.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b./g;
const APPROVAL_HEADING = "Requesting permission for:";
const APPROVAL =
  /Requesting permission for:\n([\s\S]*?)\n\s*((?:Run this command|Allow [^\n?]{1,80})\?)\n\s*>?\s*1\./;
/** Text that means an approval prompt resolved, so the next one is new. */
const RESOLVED = /User declined the tool call|exited with code|Running command/;
/** A clear-screen sequence: what follows repaints history. */
// oxlint-disable-next-line no-control-regex -- matching terminal control bytes is the point.
const CLEAR_SCREEN = /\x1b\[[23]J|\x1bc/;
const MARKERS: Array<{ kind: Marker; pattern: RegExp }> = [
  { kind: "approval", pattern: /Requesting permission for:/ },
  { kind: "trust", pattern: /Do you trust the contents of this project\?/ },
  { kind: "interrupted", pattern: /Interrupted · What should/ },
  { kind: "resolved", pattern: RESOLVED },
  { kind: "idle", pattern: /\? for shortcuts/ },
  { kind: "busy", pattern: /esc to cancel/ },
];
/** Bytes of unmatched text kept across chunks for markers split mid-write. */
const TAIL_KEEP = 256;
/** An approval block longer than this is not one agy painted. */
const APPROVAL_MAX = 8192;

type Marker = "approval" | "trust" | "interrupted" | "resolved" | "idle" | "busy";

/** Removes terminal control sequences and normalises line endings. */
export function plainText(raw: string): string {
  return raw
    .replace(ESCAPE_SEQUENCES, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");
}

/** Incremental scanner over agy's raw terminal output. */
export class ScreenScanner {
  private buffer = "";
  private repainting = false;
  private pendingApproval: string | null = null;
  private trustSeen = false;

  /** Feeds one decoded output chunk and returns the events it completed. */
  push(chunk: string): ScreenEvent[] {
    if (CLEAR_SCREEN.test(chunk)) this.repainting = true;
    this.buffer += plainText(chunk);
    const events: ScreenEvent[] = [];
    for (;;) {
      const next = this.nextMarker();
      if (next === null) break;
      if (next.kind === "approval") {
        if (this.takeApproval(next.index, events)) continue;
        return events;
      }
      this.buffer = this.buffer.slice(next.index + next.length);
      this.apply(next.kind, events);
    }
    this.buffer = this.buffer.slice(-TAIL_KEEP);
    return events;
  }

  /**
   * Consumes the approval block at `index`. Returns false when the block is
   * still being written, leaving it buffered for the next chunk.
   */
  private takeApproval(index: number, events: ScreenEvent[]): boolean {
    const block = APPROVAL.exec(this.buffer.slice(index));
    if (block === null) {
      const oversized = this.buffer.length - index > APPROVAL_MAX;
      // An oversized "block" is not one agy painted: skip its heading.
      this.buffer = this.buffer.slice(oversized ? index + APPROVAL_HEADING.length : index);
      return oversized;
    }
    this.buffer = this.buffer.slice(index + block.index + block[0].length);
    const command = commandText(block[1] ?? "");
    if (command !== "" && command !== this.pendingApproval) {
      this.pendingApproval = command;
      events.push({ type: "approval", command, question: block[2] ?? "" });
    }
    return true;
  }

  private apply(kind: Exclude<Marker, "approval">, events: ScreenEvent[]): void {
    switch (kind) {
      case "trust":
        if (!this.trustSeen) {
          this.trustSeen = true;
          events.push({ type: "trust" });
        }
        return;
      case "interrupted":
        this.pendingApproval = null;
        if (!this.repainting) events.push({ type: "interrupted" });
        return;
      case "resolved":
        this.pendingApproval = null;
        return;
      case "idle":
        this.repainting = false;
        this.pendingApproval = null;
        return;
      case "busy":
        this.repainting = false;
        return;
      default:
        return;
    }
  }

  /** Finds the earliest marker in the buffer. */
  private nextMarker(): { kind: Marker; index: number; length: number } | null {
    let best: { kind: Marker; index: number; length: number } | null = null;
    for (const { kind, pattern } of MARKERS) {
      const match = pattern.exec(this.buffer);
      if (match !== null && (best === null || match.index < best.index)) {
        best = { kind, index: match.index, length: match[0].length };
      }
    }
    return best;
  }
}

/** Joins the (possibly wrapped) command lines of an approval block. */
function commandText(block: string): string {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}
