import { describe, expect, it } from "vitest";

import { createKimiTrustScanner, KIMI_TRUST_KEYS } from "./trust";

/** The gate as Kimi Code 0.36.1 draws it, split across chunks mid-escape. */
const GATE = [
  "\x1b[?1049h\x1b[2J\x1b[1m  Trust this fol",
  "der?\x1b[0m\r\n  ↑↓ navigate · Enter select · Esc exit\r\n",
  "  /repo/.pragma/worktrees/abc\r\n  Project-level MCP servers are disabled until you",
  " explicitly choose Trust.\r\n     Trust this folder\r\n",
  "     Enable project MCP servers. Remembered for this folder.\r\n",
  "   \x1b[36m❯ Don't trust\x1b[0m\r\n     Exit Kimi Code. Asked again next launch.\r\n",
];

describe("Kimi trust gate", () => {
  it("fires once, and only after the last row is drawn", () => {
    const scanner = createKimiTrustScanner();
    const fired = GATE.map((chunk) => scanner.push(chunk));
    expect(fired).toEqual([false, false, false, false, false, true]);
    expect(scanner.push(GATE.join(""))).toBe(false);
  });

  it("ignores a session that never shows the gate", () => {
    const scanner = createKimiTrustScanner();
    expect(scanner.push("Send /help for help information.\r\n > ")).toBe(false);
    // A reply that merely mentions trust is not the dialog.
    expect(scanner.push("You asked: should I trust this folder? I cannot say.")).toBe(false);
  });

  it("selects the row above the default", () => {
    expect(KIMI_TRUST_KEYS).toBe("\x1b[A\r");
  });
});
