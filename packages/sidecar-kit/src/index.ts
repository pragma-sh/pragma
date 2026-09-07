/**
 * Splits `process.stdin` into trimmed, non-empty NDJSON lines and invokes
 * `onLine` for each one. Shared by every host sidecar's line-buffered stdin
 * reader (`pragma-ai`, `pragma-automations`, `pragma-plugins`) so the
 * buffer-scan logic isn't hand-copied per package.
 *
 * `onEnd` runs exactly once when the supervising process closes stdin. A
 * long-lived sidecar must use it to release its own timers/listeners and exit:
 * parent death closes the pipe even when the parent cannot run Rust cleanup.
 */
export function readStdinLines(onLine: (line: string) => void, onEnd?: () => void): void {
  let buffer = "";
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    onEnd?.();
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
}

/**
 * Reads all of `process.stdin` as one UTF-8 string.
 *
 * For the one-shot sidecars: a single JSON payload that is too long, too
 * multi-line, or too private to pass as a command-line argument — a pull
 * request body, an AI context — where line framing buys nothing because the
 * process reads exactly one request and exits.
 */
export async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk as string;
  }
  return buffer;
}
