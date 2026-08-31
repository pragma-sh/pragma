import { createHighlighter, type Highlighter } from "shiki";

import { cn } from "@/lib/utils";

/**
 * The Shiki theme the docs already render code with.
 *
 * Fumadocs' `rehypeCode` defaults to the GitHub pair, so the landing frame uses
 * the dark half of it rather than inventing a second set of source colours.
 */
const CODE_THEME = "github-dark";

/** One highlighter serves every frame on the page; building one is expensive. */
let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [CODE_THEME], langs: ["tsx"] });
  return highlighterPromise;
}

/**
 * Static source frame, the sibling of `TerminalCard`.
 *
 * Used where the API itself says more than a screen recording would: the reader
 * sees the whole contribution surface in one glance. Highlighted at build time
 * by Shiki, so no highlighter reaches the browser bundle; only the token
 * colours are inlined, and the card keeps the page's own surface and border.
 */
export async function CodeCard({
  title,
  code,
  className,
}: {
  title: string;
  code: string;
  className?: string;
}) {
  const highlighter = await getHighlighter();
  const { tokens } = highlighter.codeToTokens(code, { lang: "tsx", theme: CODE_THEME });

  // Keys are assigned here rather than in the render, so repeated lines (a bare
  // `}),`, a blank line) stay stable without an array index inside the JSX.
  const lines = tokens.map((line, lineIndex) => ({
    key: `${lineIndex}`,
    tokens: line.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      text: token.content,
      color: token.color,
    })),
  }));

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
      <pre className="text-foreground overflow-x-auto px-4 py-4 font-mono text-[13px] leading-[1.5]">
        <code>
          {lines.map((line) => (
            <div key={line.key}>
              {line.tokens.length === 0
                ? " "
                : line.tokens.map((token) => (
                    <span key={token.key} style={{ color: token.color }}>
                      {token.text}
                    </span>
                  ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
