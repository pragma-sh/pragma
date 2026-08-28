// Geometry for the highlight drawn around a barcode the camera has found.
// `expo-camera` reports corner points (and a bounding box) already converted to
// the camera view's own coordinate space on both iOS and Android, so the only
// work left is reducing them to one padded, clamped rectangle — kept pure here
// so it can be tested without a camera.

/** A point in the camera view's coordinate space. */
export interface ScanPoint {
  x: number;
  y: number;
}

/** The structural subset of `expo-camera`'s `BarcodeScanningResult` used here. */
export interface ScanGeometry {
  cornerPoints?: ScanPoint[];
  bounds?: { origin: ScanPoint; size: { width: number; height: number } };
}

/** A rectangle to draw over the camera preview, in view coordinates. */
export interface ScanFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Size of the camera view the frame is drawn into. */
export interface ScanViewSize {
  width: number;
  height: number;
}

/** Breathing room around the code so the border never sits on the pattern. */
const FRAME_PADDING = 10;

/** How far a corner may move before the highlight is re-rendered. */
const MOVE_TOLERANCE = 4;

/**
 * Reduces one detection to the rectangle to highlight, or `null` when the
 * report is unusable (empty corners, a zero-sized box, a code the view has
 * already scrolled past). Corner points are preferred over `bounds` because
 * they are the values both platforms fill in most reliably.
 */
export function scanFrame(result: ScanGeometry, view: ScanViewSize): ScanFrame | null {
  if (!isPositive(view.width) || !isPositive(view.height)) return null;
  const detected = fromCorners(result.cornerPoints) ?? fromBounds(result.bounds);
  if (!detected) return null;
  const left = Math.max(0, detected.left - FRAME_PADDING);
  const top = Math.max(0, detected.top - FRAME_PADDING);
  const right = Math.min(view.width, detected.right + FRAME_PADDING);
  const bottom = Math.min(view.height, detected.bottom + FRAME_PADDING);
  // A detection reported against a different coordinate space (a stale layout,
  // or a web build whose video is letterboxed) clamps to nothing: draw no box
  // rather than a misleading one.
  if (right - left < 1 || bottom - top < 1) return null;
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/**
 * Whether two frames are close enough to treat as the same detection. The
 * scanner fires per camera frame, so without this the highlight would re-render
 * (and jitter) many times a second while the code sits still.
 */
export function sameScanFrame(a: ScanFrame | null, b: ScanFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) <= MOVE_TOLERANCE &&
    Math.abs(a.y - b.y) <= MOVE_TOLERANCE &&
    Math.abs(a.width - b.width) <= MOVE_TOLERANCE &&
    Math.abs(a.height - b.height) <= MOVE_TOLERANCE
  );
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function fromCorners(corners: ScanPoint[] | undefined): Box | null {
  const points = (corners ?? []).filter((point) => isFinite(point.x) && isFinite(point.y));
  if (points.length < 3) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return boundingBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function fromBounds(bounds: ScanGeometry["bounds"]): Box | null {
  if (!bounds) return null;
  const { origin, size } = bounds;
  if (!isFinite(origin.x) || !isFinite(origin.y)) return null;
  if (!isPositive(size.width) || !isPositive(size.height)) return null;
  return boundingBox(origin.x, origin.y, origin.x + size.width, origin.y + size.height);
}

function boundingBox(left: number, top: number, right: number, bottom: number): Box | null {
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function isFinite(value: number): boolean {
  return Number.isFinite(value);
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
