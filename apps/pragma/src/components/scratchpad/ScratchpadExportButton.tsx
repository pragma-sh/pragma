import { useRef, useState } from "react";

import { Download, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

/** Exports the live scratchpad buffer as a portable, offline HTML document. */
export function ScratchpadExportButton({
  source,
  filePath,
  worktreeId,
}: {
  source: () => string;
  filePath: string;
  worktreeId: string;
}) {
  const busy = useRef(false);
  const [exporting, setExporting] = useState(false);
  const exportHtml = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setExporting(true);
    const currentSource = source();
    try {
      const { exportScratchpad } = await import("@/lib/scratchpad-export");
      const path = await exportScratchpad({ source: currentSource, filePath, worktreeId });
      toast.success("Scratchpad exported", { description: path });
    } catch (error) {
      toast.error("Could not export scratchpad", { description: errorMessage(error) });
    } finally {
      busy.current = false;
      setExporting(false);
    }
  };
  return (
    <Button
      className="h-6 gap-1 px-2 text-xs"
      disabled={exporting}
      onClick={() => void exportHtml()}
      variant="secondary"
    >
      {exporting ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      {exporting ? "Exporting…" : "Export HTML"}
    </Button>
  );
}
