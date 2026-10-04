/** Characters that continue a mention, so `@#1` is not found inside `@#12`. */
const MENTION_CONTINUES = /[\p{L}\p{N}_/-]/u;

/** Drops the backslash escapes the markdown serializer adds (`my\_file` → `my_file`). */
export function unescapeMarkdown(markdown: string): string {
  return markdown.replaceAll(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");
}

/**
 * Whether `mention` appears in `text` as a whole token: preceded by the start
 * or whitespace, and not immediately continued by another name character. A
 * trailing `.` counts as sentence punctuation only when nothing follows it.
 */
export function hasMention(text: string, mention: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(mention, from);
    if (at === -1) return false;
    from = at + 1;
    if (at > 0 && !/\s/.test(text[at - 1]!)) continue;
    const next = text[at + mention.length];
    if (next === undefined) return true;
    if (MENTION_CONTINUES.test(next)) continue;
    if (next === "." && MENTION_CONTINUES.test(text[at + mention.length + 1] ?? "")) continue;
    return true;
  }
}
