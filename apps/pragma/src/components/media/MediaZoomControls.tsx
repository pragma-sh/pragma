import { Check, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clampScale } from "@/components/media/use-media-transform";

/** Fixed magnifications offered by the zoom menu (1 = natural pixels). */
const ZOOM_STEPS: number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

/** Zoom in/out, the current magnification, and fit / actual-size presets. */
export function MediaZoomControls({
  percent,
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  onActualSize,
  onZoomTo,
}: {
  percent: number;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActualSize: () => void;
  onZoomTo: (scale: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Button
        aria-label="Zoom out"
        onClick={onZoomOut}
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
            size="sm"
            variant="ghost"
          >
            {percent}%
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuItem onSelect={onFit}>
            <Check className="opacity-0" />
            Fit to pane
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onActualSize}>
            <Check className={Math.abs(scale - 1) < 0.001 ? "opacity-100" : "opacity-0"} />
            Actual size
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {ZOOM_STEPS.map((level) => (
            <DropdownMenuItem key={level} onSelect={() => onZoomTo(clampScale(level))}>
              <Check className={Math.abs(scale - level) < 0.001 ? "opacity-100" : "opacity-0"} />
              {Math.round(level * 100)}%
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label="Zoom in"
        onClick={onZoomIn}
        size="icon-sm"
        title="Zoom in"
        variant="ghost"
      >
        <ZoomIn />
      </Button>
    </div>
  );
}
