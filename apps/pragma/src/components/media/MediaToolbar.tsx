import { MediaZoomControls } from "@/components/media/MediaZoomControls";

/** The viewer's single bar: filename on the left, zoom on the right. */
export function MediaToolbar({
  name,
  percent,
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  onActualSize,
  onZoomTo,
}: {
  name: string;
  percent: number;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActualSize: () => void;
  onZoomTo: (scale: number) => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2">
      <p className="truncate text-xs text-muted-foreground">{name}</p>
      <MediaZoomControls
        onActualSize={onActualSize}
        onFit={onFit}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomTo={onZoomTo}
        percent={percent}
        scale={scale}
      />
    </div>
  );
}
