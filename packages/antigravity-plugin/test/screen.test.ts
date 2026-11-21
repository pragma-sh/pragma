import { describe, expect, test } from "vitest";

import { plainText, ScreenScanner } from "../src/screen";

/** The approval block exactly as agy 1.5.13 writes it (captured from a PTY). */
const APPROVAL =
  "\u001b[37;1mRequesting permission for:\u001b[m\u001b[K\r\n\u001b[37m   cd /etc && rm -f /tmp/pragma-probe-y\u001b[m\u001b[K\r\n\n\u001b[1mRun this command?\u001b[m\r\n\u001b[94m> 1. Yes, run command\u001b[K\u001b[m\r\n  2. Yes, and always allow in this conversation\r\n  4. No, cancel\r\n\n\u001b[90mesc to cancel\u001b[m";
const INTERRUPTED =
  "\u001b[90m  ⎿  Interrupted · What should Antigravity CLI do instead?\u001b[m\r\n";
const BUSY = "\u001b[90mesc to cancel\u001b[m";
const IDLE = "? for shortcuts";

describe("ScreenScanner", () => {
  test("reports an approval prompt once with its command", () => {
    const scanner = new ScreenScanner();
    expect(scanner.push(APPROVAL)).toEqual([
      {
        type: "approval",
        command: "cd /etc && rm -f /tmp/pragma-probe-y",
        question: "Run this command?",
      },
    ]);
    // A repaint of the same prompt is not a new request.
    expect(scanner.push(APPROVAL)).toEqual([]);
  });

  test("assembles a prompt split across chunks", () => {
    const scanner = new ScreenScanner();
    const middle = APPROVAL.indexOf("Run this");
    expect(scanner.push(APPROVAL.slice(0, middle))).toEqual([]);
    expect(scanner.push(APPROVAL.slice(middle))).toHaveLength(1);
  });

  test("the same command asked again after it resolved is a new request", () => {
    const scanner = new ScreenScanner();
    scanner.push(APPROVAL);
    scanner.push("Command exited with code 0.\r\n");
    expect(scanner.push(APPROVAL)).toHaveLength(1);
  });

  test("an interrupt clears, even when the busy footer was never painted", () => {
    const scanner = new ScreenScanner();
    expect(scanner.push(`${BUSY}${INTERRUPTED}${IDLE}`)).toEqual([{ type: "interrupted" }]);
    // Under load agy can coalesce the busy footer away entirely.
    expect(scanner.push(`> prompt\r\n${INTERRUPTED}`)).toEqual([{ type: "interrupted" }]);
  });

  test("a full-screen repaint of old history never clears a later turn", () => {
    const scanner = new ScreenScanner();
    expect(scanner.push(`\u001b[H\u001b[2J> old\r\n${INTERRUPTED}${BUSY}`)).toEqual([]);
    // The repaint ended at the footer; a fresh interrupt counts again.
    expect(scanner.push(INTERRUPTED)).toEqual([{ type: "interrupted" }]);
  });

  test("reports the trust gate once", () => {
    const scanner = new ScreenScanner();
    const gate = "Do you trust the contents of this project?\r\n> Yes, I trust this folder";
    expect(scanner.push(gate)).toEqual([{ type: "trust" }]);
    expect(scanner.push(gate)).toEqual([]);
  });

  test("other tools' approval questions are recognised", () => {
    const scanner = new ScreenScanner();
    const url =
      "Requesting permission for:\r\n   https://example.com\r\n\r\nAllow access to this URL?\r\n> 1. Yes\r\n";
    expect(scanner.push(url)).toEqual([
      { type: "approval", command: "https://example.com", question: "Allow access to this URL?" },
    ]);
  });
});

test("plainText strips control sequences and normalises newlines", () => {
  expect(plainText("\u001b[1mA\u001b[m\r\nB\u001b]11;?\u0007")).toBe("A\nB");
});
