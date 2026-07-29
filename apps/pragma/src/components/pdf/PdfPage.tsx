import { PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer } from "@embedpdf/plugin-render/react";
import type { PageLayout } from "@embedpdf/plugin-scroll/react";
import { SelectionLayer } from "@embedpdf/plugin-selection/react";

/**
 * One page of the document: the rasterized page image with a transparent text
 * layer over it so the text stays selectable and copyable. `width`/`height`
 * come from the scroll plugin's layout and already account for the current
 * zoom, so the page box uses them verbatim. Scale and rotation are left off the
 * layers deliberately — omitted, they track the document's own state.
 */
export function PdfPage({ documentId, page }: { documentId: string; page: PageLayout }) {
  const { pageIndex, width, height } = page;
  return (
    <div
      className="relative overflow-hidden bg-white shadow-md ring-1 ring-black/10"
      style={{ width, height }}
    >
      <RenderLayer
        className="block h-full w-full select-none"
        documentId={documentId}
        pageIndex={pageIndex}
      />
      <PagePointerProvider
        className="absolute inset-0"
        documentId={documentId}
        pageIndex={pageIndex}
      >
        <SelectionLayer documentId={documentId} pageIndex={pageIndex} />
      </PagePointerProvider>
    </div>
  );
}
