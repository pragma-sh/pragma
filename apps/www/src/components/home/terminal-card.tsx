import { cn } from "@/lib/utils";

/** One printed line of a sample session. */
export interface TerminalLine {
  /** Shell prompt line; rendered with a `$` and highlighted. */
  command?: string;
  /** Program output; rendered dim. */
  output?: string;
  /** Output that should read as a success signal. */
  tone?: "muted" | "success" | "accent";
}

/** Colour a line of program output carries, by tone. */
function outputToneClass(tone: TerminalLine["tone"]): string {
  if (tone === "success") return "text-success";
  if (tone === "accent") return "text-brand";
  return "text-muted-foreground";
}

/** One printed line: a shell prompt, or a tinted line of output under it. */
function TerminalLineRow({ line, index }: { line: TerminalLine; index: number }) {
  if (line.command) {
    return (
      <div className={index > 0 ? "mt-3" : undefined}>
        <span className="text-brand select-none">$ </span>
        <span className="text-foreground">{line.command}</span>
      </div>
    );
  }
  return (
    <div>
      <span className={outputToneClass(line.tone)}>{line.output}</span>
    </div>
  );
}

/**
 * Static terminal frame used where a screenshot would say less than the command
 * itself. Purely decorative — it carries no live state and is hidden from the
 * accessibility tree beyond its own label.
 */
export function TerminalCard({
  title,
  lines,
  className,
}: {
  title: string;
  lines: readonly TerminalLine[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border bg-card shadow-raised overflow-hidden rounded-xl border",
        className,
      )}
    >
      <div className="border-border bg-elevated flex items-center gap-2 border-b px-4 py-2.5">
        <span aria-hidden className="bg-destructive size-2.5 rounded-full" />
        <span aria-hidden className="bg-warning size-2.5 rounded-full" />
        <span aria-hidden className="bg-success size-2.5 rounded-full" />
        <span className="text-muted-foreground ml-2 font-mono text-xs">{title}</span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-[1.5]">
        <code>
          {lines.map((line, index) => (
            <TerminalLineRow key={line.command ?? line.output ?? index} line={line} index={index} />
          ))}
        </code>
      </pre>
    </div>
  );
}
