import type { TerminalViewerCommand } from "@pragma-sh/terminal-viewer";
import { describe, expect, it } from "vitest";

import { createTerminalCommandQueue, TERMINAL_COMMAND_QUEUE_LIMIT } from "./terminal-command-queue";

function write(dataBase64: string): TerminalViewerCommand {
  return { type: "write", dataBase64 };
}

describe("createTerminalCommandQueue", () => {
  it("holds commands sent before the renderer is ready", () => {
    const delivered: TerminalViewerCommand[] = [];
    const queue = createTerminalCommandQueue((command) => delivered.push(command));

    queue.send(write("a"));
    queue.send(write("b"));

    expect(delivered).toEqual([]);
  });

  it("flushes what it held, in order, once ready", () => {
    const delivered: TerminalViewerCommand[] = [];
    const queue = createTerminalCommandQueue((command) => delivered.push(command));

    queue.send(write("a"));
    queue.send({ type: "reset" });
    queue.send(write("b"));
    queue.ready();

    expect(delivered).toEqual([write("a"), { type: "reset" }, write("b")]);
  });

  it("passes later commands straight through", () => {
    const delivered: TerminalViewerCommand[] = [];
    const queue = createTerminalCommandQueue((command) => delivered.push(command));

    queue.ready();
    queue.send(write("a"));

    expect(delivered).toEqual([write("a")]);
  });

  // A renderer that never loads must not grow the buffer without bound.
  it("keeps only the most recent commands past the cap", () => {
    const delivered: TerminalViewerCommand[] = [];
    const queue = createTerminalCommandQueue((command) => delivered.push(command));

    for (let index = 0; index < TERMINAL_COMMAND_QUEUE_LIMIT + 10; index += 1) {
      queue.send(write(String(index)));
    }
    queue.ready();

    expect(delivered).toHaveLength(TERMINAL_COMMAND_QUEUE_LIMIT);
    expect(delivered[0]).toEqual(write("10"));
  });

  // The document reloads when the palette changes; anything held was aimed at
  // the screen that just went away.
  it("drops what it held and gates again after a reset", () => {
    const delivered: TerminalViewerCommand[] = [];
    const queue = createTerminalCommandQueue((command) => delivered.push(command));

    queue.ready();
    queue.reset();
    queue.send(write("a"));
    expect(delivered).toEqual([]);

    queue.ready();
    expect(delivered).toEqual([write("a")]);
  });
});
