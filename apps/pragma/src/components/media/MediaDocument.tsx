/* oxlint-disable jsx-a11y/media-has-caption -- local project media has no sidecar caption tracks; the viewer plays the file as-is. */
import { useCallback, useState, type KeyboardEvent, type SyntheticEvent } from "react";

import { AudioPlayer } from "@/components/media/AudioPlayer";
import type { MediaKind } from "@/components/media/media-path";
import { MediaKeyboardSurface } from "@/components/media/MediaKeyboardSurface";
import { MediaToolbar } from "@/components/media/MediaToolbar";
import { useMediaTransform } from "@/components/media/use-media-transform";

/**
 * Zoom keys, by the `key` they arrive as. `=` is here because it is the
 * unshifted key most keyboards print `+` on.
 */
type ZoomActions = {
  zoomIn: () => void;
  zoomOut: () => void;
  setActualSize: () => void;
  resetFit: () => void;
};

const ZOOM_SHORTCUTS: Record<string, (actions: ZoomActions) => void> = {
  "+": (actions) => actions.zoomIn(),
  "=": (actions) => actions.zoomIn(),
  "-": (actions) => actions.zoomOut(),
  "0": (actions) => actions.setActualSize(),
  "9": (actions) => actions.resetFit(),
};

/** Read-only image / video surface with fit-to-pane, zoom, and pan. */
export function MediaDocument({
  url,
  mediaKind,
  name,
}: {
  url: string;
  mediaKind: MediaKind;
  name: string;
}) {
  if (mediaKind === "audio") {
    return <AudioPlayer name={name} url={url} />;
  }
  return <VisualDocument mediaKind={mediaKind} name={name} url={url} />;
}

/** Image or video with a shared pan/zoom viewport. */
function VisualDocument({
  url,
  mediaKind,
  name,
}: {
  url: string;
  mediaKind: "image" | "video";
  name: string;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const transform = useMediaTransform(natural);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const zoom = ZOOM_SHORTCUTS[event.key];
      if (!zoom) return;
      event.preventDefault();
      zoom(transform);
    },
    [transform],
  );

  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    setNatural({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    });
  };

  const onVideoMeta = (event: SyntheticEvent<HTMLVideoElement>) => {
    const width = event.currentTarget.videoWidth;
    const height = event.currentTarget.videoHeight;
    if (width > 0 && height > 0) setNatural({ width, height });
  };

  const transformed = natural !== null;
  const frameStyle = transformed
    ? {
        width: natural.width,
        height: natural.height,
        transform: `translate(-50%, -50%) translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.scale})`,
        transformOrigin: "center center",
      }
    : undefined;

  return (
    <MediaKeyboardSurface onKeyDown={onKeyDown}>
      <MediaToolbar
        name={name}
        onActualSize={transform.setActualSize}
        onFit={transform.resetFit}
        onZoomIn={transform.zoomIn}
        onZoomOut={transform.zoomOut}
        onZoomTo={transform.zoomTo}
        percent={transform.percent}
        scale={transform.scale}
      />
      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-canvas active:cursor-grabbing"
        onPointerDown={transform.onPointerDown}
        onPointerMove={transform.onPointerMove}
        onPointerUp={transform.onPointerUp}
        onPointerCancel={transform.onPointerUp}
        onWheel={transform.onWheel}
        ref={transform.viewportRef}
      >
        <div
          className={
            transformed
              ? "absolute left-1/2 top-1/2 will-change-transform"
              : "flex h-full w-full items-center justify-center p-4"
          }
          style={frameStyle}
        >
          {mediaKind === "image" ? (
            <img
              alt={name}
              className={
                transformed
                  ? "pointer-events-none h-full w-full select-none"
                  : "pointer-events-none max-h-full max-w-full select-none object-contain"
              }
              draggable={false}
              onLoad={onImageLoad}
              src={url}
            />
          ) : (
            <video
              aria-label={name}
              className={transformed ? "h-full w-full" : "max-h-full max-w-full"}
              controls
              onLoadedMetadata={onVideoMeta}
              onPointerDown={(event) => event.stopPropagation()}
              preload="metadata"
              src={url}
            />
          )}
        </div>
      </div>
    </MediaKeyboardSurface>
  );
}
