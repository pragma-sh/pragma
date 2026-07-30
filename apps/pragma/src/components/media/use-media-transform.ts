import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";

/** Zoom step applied by buttons / ⌘±. */
const ZOOM_STEP = 1.25;
/** Hard floors / ceilings on absolute scale (pixels of natural size). */
const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

/** Fit-to-pane scale, capped at 1 so small media stays centered at native size. */
export function fitScale(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): number {
  if (naturalWidth <= 0 || naturalHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return 1;
  }
  return Math.min(1, containerWidth / naturalWidth, containerHeight / naturalHeight);
}

/** Clamps an absolute scale into the allowed preview range. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

type Size = { width: number; height: number };

/**
 * Pan/zoom transform for a media element that fits its pane by default.
 * `scale` is absolute (1 = natural pixels); pan is in CSS pixels of the viewport.
 */
export function useMediaTransform(natural: Size | null) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitted, setFitted] = useState(true);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    panX: number;
    panY: number;
  } | null>(null);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const sync = (width: number, height: number) => {
      setContainer({ width, height });
    };
    sync(node.clientWidth, node.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      sync(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Re-fit when the natural size or pane size changes and the user has not
  // taken over with an explicit zoom.
  useEffect(() => {
    if (!natural || !fitted) return;
    const next = fitScale(container.width, container.height, natural.width, natural.height);
    setScale(next);
    setPan({ x: 0, y: 0 });
  }, [natural, container.width, container.height, fitted]);

  const zoomTo = useCallback((nextScale: number, originX?: number, originY?: number) => {
    setFitted(false);
    setScale((previous) => {
      const clamped = clampScale(nextScale);
      if (originX !== undefined && originY !== undefined && previous > 0) {
        // Keep the point under the cursor stable across the scale change.
        const ratio = clamped / previous;
        setPan((current) => ({
          x: originX - (originX - current.x) * ratio,
          y: originY - (originY - current.y) * ratio,
        }));
      }
      return clamped;
    });
  }, []);

  const zoomBy = useCallback((factor: number, originX?: number, originY?: number) => {
    setFitted(false);
    setScale((previous) => {
      const clamped = clampScale(previous * factor);
      if (originX !== undefined && originY !== undefined && previous > 0) {
        const ratio = clamped / previous;
        setPan((current) => ({
          x: originX - (originX - current.x) * ratio,
          y: originY - (originY - current.y) * ratio,
        }));
      }
      return clamped;
    });
  }, []);

  const resetFit = useCallback(() => {
    setFitted(true);
  }, []);

  const zoomIn = useCallback(() => {
    zoomBy(ZOOM_STEP);
  }, [zoomBy]);

  const zoomOut = useCallback(() => {
    zoomBy(1 / ZOOM_STEP);
  }, [zoomBy]);

  const setActualSize = useCallback(() => {
    zoomTo(1);
    setPan({ x: 0, y: 0 });
  }, [zoomTo]);

  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const originX = event.clientX - rect.left - rect.width / 2;
      const originY = event.clientY - rect.top - rect.height / 2;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomBy(factor, originX, originY);
    },
    [zoomBy],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    },
    [pan.x, pan.y],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setFitted(false);
    setPan({
      x: drag.panX + (event.clientX - drag.originX),
      y: drag.panY + (event.clientY - drag.originY),
    });
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);

  const percent = Math.round(scale * 100);

  return {
    viewportRef,
    scale,
    pan,
    percent,
    zoomIn,
    zoomOut,
    resetFit,
    setActualSize,
    zoomTo,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
