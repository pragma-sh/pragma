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
            <div
              key={line.command ?? line.output ?? index}
              className={index > 0 && line.command ? "mt-3" : undefined}
            >
              {line.command ? (
                <>
                  <span className="text-brand select-none">$ </span>
                  <span className="text-foreground">{line.command}</span>
                </>
              ) : (
                <span
                  className={cn(
                    line.tone === "success" && "text-success",
                    line.tone === "accent" && "text-brand",
                    (!line.tone || line.tone === "muted") && "text-muted-foreground",
                  )}
                >
                  {line.output}
                </span>
              )}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
