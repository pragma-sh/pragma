import { useZoom, ZoomMode, type ZoomLevel } from "@embedpdf/plugin-zoom/react";
import { Check, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Fit modes and fixed magnifications offered by the zoom menu. */
const ZOOM_PRESETS: { label: string; level: ZoomLevel }[] = [
  { label: "Automatic", level: ZoomMode.Automatic },
  { label: "Fit page", level: ZoomMode.FitPage },
  { label: "Fit width", level: ZoomMode.FitWidth },
];
const ZOOM_STEPS: number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 4];

/** Zoom in/out, the current magnification, and the fit-mode menu behind it. */
export function PdfZoomControls({ documentId }: { documentId: string }) {
  const { state, provides } = useZoom(documentId);
  const percent = Math.round(state.currentZoomLevel * 100);

  return (
    <div className="flex items-center gap-0.5">
      <Button
        aria-label="Zoom out"
        disabled={!provides}
        onClick={() => provides?.zoomOut()}
        size="icon-sm"
        title="Zoom out"
        variant="ghost"
      >
        <ZoomOut />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Zoom: ${percent}%`}
            className="min-w-14 tabular-nums"
            disabled={!provides}
            size="sm"
            variant="ghost"
          >
            {percent}%
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          {ZOOM_PRESETS.map(({ label, level }) => (
            <DropdownMenuItem key={label} onSelect={() => provides?.requestZoom(level)}>
              <Check className={state.zoomLevel === level ? "opacity-100" : "opacity-0"} />
              {label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {ZOOM_STEPS.map((level) => (
            <DropdownMenuItem key={level} onSelect={() => provides?.requestZoom(level)}>
              <Check className={state.zoomLevel === level ? "opacity-100" : "opacity-0"} />
              {Math.round(level * 100)}%
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label="Zoom in"
        disabled={!provides}
        onClick={() => provides?.zoomIn()}
        size="icon-sm"
        title="Zoom in"
        variant="ghost"
      >
        <ZoomIn />
      </Button>
    </div>
  );
}
