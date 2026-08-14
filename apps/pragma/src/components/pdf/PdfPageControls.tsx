import { useEffect, useState } from "react";

import { useScroll } from "@embedpdf/plugin-scroll/react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";

/**
 * Page readout with prev/next and a type-a-number box. The input mirrors the
 * scroll plugin's current page while the user is not editing it, so scrolling
 * and typing stay in sync without fighting each other.
 */
export function PdfPageControls({ documentId }: { documentId: string }) {
  const { state, provides } = useScroll(documentId);
  const { currentPage, totalPages } = state;
  const [draft, setDraft] = useState(String(currentPage));

  useEffect(() => setDraft(String(currentPage)), [currentPage]);

  const commit = (value: string) => {
    const pageNumber = Number.parseInt(value, 10);
    if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
      setDraft(String(currentPage));
      return;
    }
    provides?.scrollToPage({ pageNumber });
  };

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        disabled={!provides || currentPage <= 1}
        label="Previous page"
        size="icon-sm"
        variant="ghost"
        onClick={() => provides?.scrollToPreviousPage()}
      >
        <ChevronUp />
      </IconButton>
      <IconButton
        disabled={!provides || currentPage >= totalPages}
        label="Next page"
        size="icon-sm"
        variant="ghost"
        onClick={() => provides?.scrollToNextPage()}
      >
        <ChevronDown />
      </IconButton>
      <label className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="sr-only">Page number</span>
        <Input
          className="h-6 w-12 px-1.5 text-center text-xs tabular-nums"
          inputMode="numeric"
          onBlur={(event) => commit(event.target.value)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
            if (event.key === "Escape") setDraft(String(currentPage));
          }}
          value={draft}
        />
        <span className="tabular-nums">of {totalPages}</span>
      </label>
    </div>
  );
}
