import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/**
 * Lazily resolves a CodeMirror language grammar for a file by its name, from
 * `@codemirror/language-data`. Returns `null` when no grammar matches or the
 * load fails, so the caller falls back to plain text. Shared by every editor,
 * diff, and viewer so all of them pick the same grammar for a given file.
 */
export async function loadLanguageExtension(filePath: string): Promise<Extension | null> {
  const description = LanguageDescription.matchFilename(languages, baseName(filePath));
  if (!description) return null;
  try {
    return await description.load();
  } catch {
    return null;
  }
}

/** The last path segment, with either separator. */
function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}
