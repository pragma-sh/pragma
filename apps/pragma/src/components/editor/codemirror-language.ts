import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

import { basename } from "@/lib/path";

/**
 * Lazily resolves a CodeMirror language grammar for a file by its name, loading
 * the matching grammar from `@codemirror/language-data`. Returns `null` when no
 * grammar matches the extension or the dynamic import fails, so the caller falls
 * back to plain text. Shared by the `editor` and `diff` tab views so both pick
 * the same grammar for a given file.
 */
export async function loadLanguageExtension(filePath: string): Promise<Extension | null> {
  const description = LanguageDescription.matchFilename(languages, basename(filePath));
  if (!description) {
    return null;
  }
  try {
    return await description.load();
  } catch {
    return null;
  }
}
