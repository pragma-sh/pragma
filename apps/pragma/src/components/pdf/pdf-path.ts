import { extname } from "@/lib/path";

/** Extensions routed to the PDF viewer instead of the CodeMirror editor. */
const PDF_EXTENSIONS = new Set(["pdf"]);

/** True when the file should open in the read-only PDF viewer surface. */
export function isPdfPath(filePath: string | null): boolean {
  return filePath !== null && PDF_EXTENSIONS.has(extname(filePath));
}
