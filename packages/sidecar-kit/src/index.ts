/**
 * Splits `process.stdin` into trimmed, non-empty NDJSON lines and invokes
 * `onLine` for each one. Shared by every host sidecar's line-buffered stdin
 * reader (`pragma-ai`, `pragma-automations`, `pragma-plugins`) so the
 * buffer-scan logic isn't hand-copied per package.
 */
export function readStdinLines(onLine: (line: string) => void): void {
  let buffer = "";
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
}
