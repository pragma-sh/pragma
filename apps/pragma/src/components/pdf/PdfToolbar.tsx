import { PdfPageControls } from "@/components/pdf/PdfPageControls";
import { PdfZoomControls } from "@/components/pdf/PdfZoomControls";

/** The viewer's single bar: page navigation on the left, zoom on the right. */
export function PdfToolbar({ documentId }: { documentId: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2">
      <PdfPageControls documentId={documentId} />
      <PdfZoomControls documentId={documentId} />
    </div>
  );
}
