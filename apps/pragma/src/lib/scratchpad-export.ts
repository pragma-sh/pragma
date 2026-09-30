import { buildScratchpadExportHtml, parseScratchpadDocument } from "@pragma-sh/scratchpad-viewer";

import { buildScratchpadPreview } from "@/lib/mdx-preview";
import { scratchpadTheme } from "@/lib/scratchpad-theme";
import { exportScratchpadHtml } from "@/lib/tauri";

/** Bundles the current document and writes a standalone export on the owning host. */
export async function exportScratchpad(options: {
  source: string;
  filePath: string;
  worktreeId: string;
}): Promise<string> {
  const document = parseScratchpadDocument(options.source);
  const theme = scratchpadTheme();
  const bundle = await buildScratchpadPreview({
    ...options,
    source: document.body,
    standalone: true,
  });
  const html = buildScratchpadExportHtml({
    ...bundle,
    title: document.metadata.title,
    mode: theme.mode,
    themeCss: theme.css,
  });
  return exportScratchpadHtml(options.worktreeId, document.metadata.title, html);
}
