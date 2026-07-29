import type { Tab } from "@pragma/constants";

import { PdfDocument } from "@/components/pdf/PdfDocument";
import { PdfStatus } from "@/components/pdf/PdfStatus";
import { usePdfEngine } from "@/components/pdf/pdf-engine";
import { formatBytes, usePdfFile } from "@/components/pdf/use-pdf-file";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { basename } from "@/lib/path";

/**
 * Read-only PDF surface for `editor` tabs whose file is a PDF, standing in for
 * the CodeMirror editor — which refuses binary content outright. Owns the two
 * things that must succeed before anything renders: the file's bytes (read in
 * chunks) and the shared pdfium engine.
 */
export function PdfView({ tab }: { tab: Tab }) {
  const { state, reload } = usePdfFile(tab);
  const engine = usePdfEngine();
  const name = tab.filePath ? basename(tab.filePath) : "document.pdf";

  if (state.kind === "error") {
    return (
      <PdfStatus>
        <p className="text-destructive">{state.message}</p>
        <Button onClick={reload} size="sm" variant="ghost">
          Retry
        </Button>
      </PdfStatus>
    );
  }

  if (state.kind === "loading") {
    const percent =
      state.totalBytes > 0 ? Math.round((state.loadedBytes / state.totalBytes) * 100) : 0;
    return (
      <PdfStatus>
        <p>
          Loading {name}
          {state.totalBytes > 0 ? ` — ${formatBytes(state.totalBytes)}` : ""}…
        </p>
        <Progress className="w-48" value={percent} />
      </PdfStatus>
    );
  }

  if (engine.kind === "error") {
    return (
      <PdfStatus>
        <p className="text-destructive">The PDF engine failed to start: {engine.message}</p>
      </PdfStatus>
    );
  }

  if (engine.kind === "loading") {
    return <PdfStatus>Starting the PDF engine…</PdfStatus>;
  }

  return <PdfDocument buffer={state.buffer} engine={engine.engine} name={name} onRetry={reload} />;
}
