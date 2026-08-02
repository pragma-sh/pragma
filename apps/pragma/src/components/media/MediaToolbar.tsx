import { MediaZoomControls } from "@/components/media/MediaZoomControls";

/** Zoom/pan controls the toolbar exposes for a media document. */
export type MediaZoomControlsState = {
  percent: number;
  scale: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetFit: () => void;
  setActualSize: () => void;
  zoomTo: (scale: number) => void;
};

/** The viewer's single bar: filename on the left, zoom on the right. */
export function MediaToolbar({ name, zoom }: { name: string; zoom: MediaZoomControlsState }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2">
      <p className="truncate text-xs text-muted-foreground">{name}</p>
      <MediaZoomControls
        onActualSize={zoom.setActualSize}
        onFit={zoom.resetFit}
        onZoomIn={zoom.zoomIn}
        onZoomOut={zoom.zoomOut}
        onZoomTo={zoom.zoomTo}
        percent={zoom.percent}
        scale={zoom.scale}
      />
    </div>
  );
}
