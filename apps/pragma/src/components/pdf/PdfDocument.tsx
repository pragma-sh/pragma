import { useMemo } from "react";

import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import type { PdfEngine } from "@embedpdf/models";
import {
  DocumentContent,
  DocumentManagerPluginPackage,
} from "@embedpdf/plugin-document-manager/react";
import {
  GlobalPointerProvider,
  InteractionManagerPluginPackage,
} from "@embedpdf/plugin-interaction-manager/react";
import { RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { Scroller, ScrollPluginPackage } from "@embedpdf/plugin-scroll/react";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection/react";
import { Viewport, ViewportPluginPackage } from "@embedpdf/plugin-viewport/react";
import { ZoomGestureWrapper, ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/react";

import { PdfKeyboardSurface } from "@/components/pdf/PdfKeyboardSurface";
import { PdfOpeningStatus } from "@/components/pdf/PdfOpeningStatus";
import { PdfPage } from "@/components/pdf/PdfPage";
import { PdfStatus } from "@/components/pdf/PdfStatus";
import { PdfToolbar } from "@/components/pdf/PdfToolbar";
import { usePdfZoomShortcuts } from "@/components/pdf/use-pdf-zoom-shortcuts";

/** Gap between pages and around the document, in CSS pixels. */
const PAGE_GAP = 16;

/**
 * The headless EmbedPDF plugin stack, keyed to one document's bytes. The
 * registration list is rebuilt whenever the buffer changes, which is what makes
 * a reload from disk swap the rendered document.
 */
function usePdfPlugins(buffer: ArrayBuffer, name: string) {
  return useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ buffer, name }],
      }),
      createPluginRegistration(ViewportPluginPackage, { viewportGap: PAGE_GAP }),
      createPluginRegistration(ScrollPluginPackage, { defaultPageGap: PAGE_GAP }),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.FitWidth }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(SelectionPluginPackage),
    ],
    [buffer, name],
  );
}

/** Toolbar plus scrolling page stack for a document that finished parsing. */
function PdfDocumentBody({ documentId }: { documentId: string }) {
  const onKeyDown = usePdfZoomShortcuts(documentId);

  return (
    <PdfKeyboardSurface onKeyDown={onKeyDown}>
      <PdfToolbar documentId={documentId} />
      <Viewport className="min-h-0 flex-1 bg-muted" documentId={documentId}>
        <GlobalPointerProvider documentId={documentId}>
          <ZoomGestureWrapper documentId={documentId}>
            <Scroller
              documentId={documentId}
              renderPage={(page) => (
                <PdfPage documentId={documentId} key={page.pageIndex} page={page} />
              )}
            />
          </ZoomGestureWrapper>
        </GlobalPointerProvider>
      </Viewport>
    </PdfKeyboardSurface>
  );
}

/**
 * Read-only PDF surface: mounts the plugin stack against the shared pdfium
 * engine and renders the document held in `buffer`.
 */
export function PdfDocument({
  buffer,
  engine,
  name,
  onRetry,
}: {
  buffer: ArrayBuffer;
  engine: PdfEngine;
  name: string;
  onRetry: () => void;
}) {
  const plugins = usePdfPlugins(buffer, name);

  return (
    <EmbedPDF engine={engine} plugins={plugins}>
      {({ activeDocumentId }) =>
        activeDocumentId ? (
          <DocumentContent documentId={activeDocumentId}>
            {({ isLoaded, isError }) => {
              if (isError) return <PdfStatus>This PDF could not be opened.</PdfStatus>;
              if (!isLoaded) return <PdfOpeningStatus name={name} onRetry={onRetry} />;
              return <PdfDocumentBody documentId={activeDocumentId} />;
            }}
          </DocumentContent>
        ) : (
          <PdfOpeningStatus name={name} onRetry={onRetry} />
        )
      }
    </EmbedPDF>
  );
}
