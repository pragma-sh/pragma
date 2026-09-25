import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronRight, ZoomOut } from "lucide-react";
import { animate } from "motion/react";

import { IconButton } from "@/components/ui/icon-button";
import { formatBytes } from "@/lib/binary-file";
import { motionTransition, useMotionTransition } from "@/lib/motion";
import type { TreemapRect } from "@/lib/treemap";
import { cn } from "@/lib/utils";

import { findNodePath, TREEMAP_MIN_FOLDER_BYTES, type StorageNode } from "./storage-model";
import {
  isZoomable,
  layoutTreemap,
  leafAt,
  PROJECT_GUTTER,
  type Leaf,
  type TreemapLayout,
} from "./treemap-layout";

/**
 * GrandPerspective's "Bujumbura" palette, sampled from its screenshots. The
 * treemap deliberately does not follow the app theme: like GrandPerspective,
 * it is a loud, fixed palette on black so adjacent folders are unmistakable.
 */
const TREEMAP_PALETTE = [
  "#3b8fe4", // blue
  "#98c41c", // lime
  "#d8d43c", // yellow
  "#d5421b", // red
  "#e27b12", // orange
  "#d9a878", // tan
  "#6f5036", // brown
] as const;

/** The line around each project, drawn in the middle of its black gutter. */
const PROJECT_FRAME_COLOR = "rgba(255, 255, 255, 0.75)";
const PROJECT_FRAME_WIDTH = 2;

/** Tiles thinner than this are filled flat; a gradient cannot show there. */
const MIN_SHADED = 3;
/** Scroll distance that counts as one zoom step, and the pause before the next. */
const WHEEL_STEP = 40;
const WHEEL_COOLDOWN_MS = 350;

function paletteColor(slot: number): string {
  const size = TREEMAP_PALETTE.length;
  return TREEMAP_PALETTE[((slot % size) + size) % size] ?? TREEMAP_PALETTE[0];
}

/** Mixes a `#rrggbb` color toward white (`amount` > 0) or black (< 0). */
function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const weight = Math.abs(amount);
  const channel = (shift: number) => {
    const base = (value >> shift) & 0xff;
    return Math.round(base + (target - base) * weight);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/**
 * The cushion look: light falls from the top-left, so every tile runs from a
 * highlight in that corner through its color to a shadow at the bottom-right.
 * With no gaps between tiles, that shading is the only edge a tile has.
 */
function drawLeaf(context: CanvasRenderingContext2D, leaf: Leaf): void {
  const { x, y, width, height } = leaf.rect;
  const color = leaf.node.kind === "pending" ? "#3a3a3a" : paletteColor(leaf.node.color);
  if (width < MIN_SHADED || height < MIN_SHADED) {
    context.fillStyle = color;
  } else {
    const gradient = context.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, shade(color, 0.55));
    gradient.addColorStop(0.45, color);
    gradient.addColorStop(1, shade(color, -0.6));
    context.fillStyle = gradient;
  }
  context.fillRect(x, y, width, height);
}

function strokeBox(context: CanvasRenderingContext2D, rect: TreemapRect, lineWidth: number) {
  const inset = lineWidth / 2;
  context.lineWidth = lineWidth;
  context.strokeRect(
    rect.x + inset,
    rect.y + inset,
    Math.max(0, rect.width - lineWidth),
    Math.max(0, rect.height - lineWidth),
  );
}

/** Sizes a canvas's backing store for the display's pixel ratio. */
function prepareCanvas(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function useElementWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Paints the tiles onto the base canvas when the layout changes, and the
 * hover outlines onto an overlay, so moving the pointer never repaints tiles.
 */
function useTreemapCanvases(
  layout: TreemapLayout,
  hovered: Leaf | null,
  width: number,
  height: number,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const context = prepareCanvas(canvasRef.current, width, height);
    if (!context) return;
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    for (const leaf of layout.leaves) drawLeaf(context, leaf);
    context.strokeStyle = PROJECT_FRAME_COLOR;
    const offset = (PROJECT_GUTTER - PROJECT_FRAME_WIDTH) / 2;
    for (const frame of layout.frames) {
      strokeBox(
        context,
        {
          x: frame.x + offset,
          y: frame.y + offset,
          width: frame.width - offset * 2,
          height: frame.height - offset * 2,
        },
        PROJECT_FRAME_WIDTH,
      );
    }
  }, [layout, width, height]);

  useEffect(() => {
    const context = prepareCanvas(overlayRef.current, width, height);
    if (!context || !hovered) return;
    // The folder a click zooms into, faintly; the square under the pointer, boldly.
    const target = hovered.clickTarget ? layout.boxes.get(hovered.clickTarget.id) : undefined;
    context.strokeStyle = "rgba(255, 255, 255, 0.6)";
    if (target && target !== hovered.rect) strokeBox(context, target, 1);
    context.strokeStyle = "#fff";
    strokeBox(context, hovered.rect, 2);
  }, [hovered, layout, width, height]);

  return { canvasRef, overlayRef };
}

/** How the next layout should animate in, recorded just before a zoom. */
type PendingZoom = { into: TreemapRect } | { outOf: string } | null;

/** The frame that, drawn at full size, puts `box` exactly over the whole view. */
function covering(box: TreemapRect, width: number, height: number): TreemapRect {
  const scaleX = width / box.width;
  const scaleY = height / box.height;
  return { x: -box.x * scaleX, y: -box.y * scaleY, width: width * scaleX, height: height * scaleY };
}

/** Where the new view starts its zoom animation from, if anywhere. */
function zoomOrigin(
  zoom: PendingZoom,
  layout: TreemapLayout,
  width: number,
  height: number,
): TreemapRect | null {
  if (!zoom) return null;
  // In: the new view grows out of the box that was clicked.
  if ("into" in zoom) return zoom.into;
  // Out: the old view shrinks back into its box in the new layout.
  const box = layout.boxes.get(zoom.outOf);
  return box ? covering(box, width, height) : null;
}

/** The zoom stack, its layout, and the animation between levels. */
function useTreemapZoom(nodes: readonly StorageNode[], width: number, height: number) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const pending = useRef<PendingZoom>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const transition = useMotionTransition(motionTransition.zoom);

  // A zoom target can vanish (rescan, scope switch, folder deleted).
  const trail = useMemo(
    () => (focusId ? (findNodePath(nodes, focusId) ?? []) : []),
    [nodes, focusId],
  );
  const focus = trail.at(-1) ?? null;
  const visible = useMemo(() => (focus ? focus.children : nodes), [focus, nodes]);
  const layout = useMemo(
    () => layoutTreemap(visible, { x: 0, y: 0, width, height }),
    [visible, width, height],
  );

  useLayoutEffect(() => {
    const from = zoomOrigin(pending.current, layout, width, height);
    pending.current = null;
    const stage = stageRef.current;
    if (!stage || !from || width === 0) return;
    void animate(
      stage,
      {
        x: [from.x, 0],
        y: [from.y, 0],
        scaleX: [from.width / width, 1],
        scaleY: [from.height / height, 1],
      },
      transition,
    );
  }, [layout, width, height, transition]);

  const zoomInto = useCallback(
    (node: StorageNode) => {
      const box = layout.boxes.get(node.id);
      if (!box || node.id === focus?.id) return;
      pending.current = { into: box };
      setFocusId(node.id);
    },
    [layout, focus],
  );
  /** Zooms out to an ancestor on the trail (`null` is the top level). */
  const zoomTo = useCallback(
    (id: string | null) => {
      const index = id === null ? -1 : trail.findIndex((node) => node.id === id);
      const child = trail[index + 1];
      if (!child) return;
      pending.current = { outOf: child.id };
      setFocusId(id);
    },
    [trail],
  );
  const zoomOut = useCallback(() => zoomTo(trail.at(-2)?.id ?? null), [trail, zoomTo]);

  return { focus, trail, layout, stageRef, zoomInto, zoomTo, zoomOut };
}

/**
 * Scrolling over the map zooms it: up zooms into the hovered region, down
 * zooms out. The listener is non-passive so the Settings page does not scroll
 * underneath the gesture.
 */
function useWheelZoom(
  element: RefObject<HTMLCanvasElement | null>,
  onZoomIn: () => void,
  onZoomOut: () => void,
) {
  const handlers = useRef({ onZoomIn, onZoomOut });
  useEffect(() => {
    handlers.current = { onZoomIn, onZoomOut };
  });
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    let travel = 0;
    let lastStep = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (performance.now() - lastStep < WHEEL_COOLDOWN_MS) return;
      travel += event.deltaY;
      if (Math.abs(travel) < WHEEL_STEP) return;
      if (travel < 0) handlers.current.onZoomIn();
      else handlers.current.onZoomOut();
      travel = 0;
      lastStep = performance.now();
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => target.removeEventListener("wheel", onWheel);
  }, [element]);
}

/** `node` when it is somewhere new to zoom into, otherwise null. */
function zoomable(
  node: StorageNode | null | undefined,
  focus: StorageNode | null,
): StorageNode | null {
  return node && node.id !== focus?.id && isZoomable(node) ? node : null;
}

/**
 * A GrandPerspective-style treemap: shaded boxes whose areas are their share
 * of the disk, packed edge to edge on a canvas — one box per top-level folder
 * of 15 MB or more in each worktree. Hovering outlines and names a box, clicking zooms into a
 * project or worktree, scrolling up zooms one level toward the pointer, and
 * scrolling down zooms out.
 */
export function StorageTreemap({
  nodes,
  rootLabel,
  height = 460,
}: {
  nodes: readonly StorageNode[];
  rootLabel: string;
  height?: number;
}) {
  const [containerRef, width] = useElementWidth();
  const [hovered, setHovered] = useState<Leaf | null>(null);
  const zoom = useTreemapZoom(nodes, width, height);
  const { canvasRef, overlayRef } = useTreemapCanvases(zoom.layout, hovered, width, height);
  // A new layout (zoom, resize, rescan) invalidates the hovered box.
  useEffect(() => setHovered(null), [zoom.layout]);

  // A click goes straight to the square that was clicked; the wheel steps one
  // level at a time toward it.
  const target = zoomable(hovered?.clickTarget, zoom.focus);
  const step = zoomable(hovered?.region, zoom.focus);
  const zoomIn = () => {
    if (target) zoom.zoomInto(target);
  };
  useWheelZoom(
    overlayRef,
    () => {
      if (step) zoom.zoomInto(step);
    },
    zoom.zoomOut,
  );

  return (
    <div>
      <TreemapBreadcrumb
        focus={zoom.focus}
        rootLabel={rootLabel}
        trail={zoom.trail}
        onSelect={zoom.zoomTo}
        onZoomOut={zoom.zoomOut}
      />
      <div ref={containerRef} className="overflow-hidden rounded-md border border-black bg-black">
        <figure className="relative m-0 overflow-hidden" style={{ height }}>
          <figcaption className="sr-only">
            Storage treemap of {zoom.focus?.label ?? rootLabel}. The Worktrees list below has the
            same sizes.
          </figcaption>
          <div ref={zoom.stageRef} className="absolute inset-0 origin-top-left">
            <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />
          </div>
          <canvas
            ref={overlayRef}
            aria-hidden
            className={cn(
              "absolute inset-0 size-full",
              target ? "cursor-zoom-in" : "cursor-default",
            )}
            onClick={zoomIn}
            onContextMenu={(event) => {
              event.preventDefault();
              zoom.zoomOut();
            }}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const leaf = leafAt(
                zoom.layout.leaves,
                event.clientX - bounds.left,
                event.clientY - bounds.top,
              );
              // React skips the render when the pointer stays on the same box.
              setHovered(leaf);
            }}
          />
          <HoverTag hovered={hovered} layout={zoom.layout} width={width} />
          {width > 0 && zoom.layout.leaves.length === 0 ? (
            <p className="absolute inset-0 grid place-items-center text-sm text-neutral-400">
              No top-level folders of {formatBytes(TREEMAP_MIN_FOLDER_BYTES)} or more.
            </p>
          ) : null}
        </figure>
        <TreemapStatusBar hovered={hovered?.node ?? null} />
      </div>
    </div>
  );
}

/** Widest a hover tag may be; it is pulled left to stay inside the map. */
const TAG_MAX_WIDTH = 288;

/** Names the hovered box and its total size, pinned to the box. */
function HoverTag({
  hovered,
  layout,
  width,
}: {
  hovered: Leaf | null;
  layout: TreemapLayout;
  width: number;
}) {
  const named = hovered?.node;
  const box = named ? layout.boxes.get(named.id) : undefined;
  if (!named || !box || named.kind === "pending") return null;
  return (
    <div
      className="pointer-events-none absolute truncate rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white shadow"
      style={{
        left: Math.max(4, Math.min(box.x + 4, width - TAG_MAX_WIDTH)),
        top: Math.max(4, box.y + 4),
        maxWidth: TAG_MAX_WIDTH,
      }}
    >
      {named.label} · {formatBytes(named.bytes)}
    </div>
  );
}

/** "All projects › pragma › main", each step zooming back out to it. */
function TreemapBreadcrumb({
  rootLabel,
  trail,
  focus,
  onSelect,
  onZoomOut,
}: {
  rootLabel: string;
  trail: readonly StorageNode[];
  focus: StorageNode | null;
  onSelect: (id: string | null) => void;
  onZoomOut: () => void;
}) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2">
      <IconButton
        disabled={!focus}
        label="Zoom out"
        size="icon-sm"
        variant="ghost"
        onClick={onZoomOut}
      >
        <ZoomOut />
      </IconButton>
      <nav aria-label="Treemap location" className="flex flex-wrap items-center gap-1 text-xs">
        <button
          className={cn("rounded px-1.5 py-0.5 hover:bg-muted", !focus && "font-medium")}
          type="button"
          onClick={() => onSelect(null)}
        >
          {rootLabel}
        </button>
        {trail.map((node) => (
          <span key={node.id} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-muted-foreground" />
            <button
              className={cn(
                "max-w-48 truncate rounded px-1.5 py-0.5 hover:bg-muted",
                node === focus && "font-medium",
              )}
              type="button"
              onClick={() => onSelect(node.id)}
            >
              {node.label}
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}

/** GrandPerspective's status line: the hovered path on the left, its size on the right. */
function TreemapStatusBar({ hovered }: { hovered: StorageNode | null }) {
  return (
    <div className="flex h-6 items-center justify-between gap-4 bg-neutral-900 px-2 font-mono text-[11px] text-neutral-200">
      <span aria-live="polite" className="min-w-0 truncate">
        {hovered
          ? hovered.path
          : "Click a square to zoom into it; scroll to zoom in and out; right-click to zoom out."}
      </span>
      {hovered && hovered.kind !== "pending" ? (
        <span className="shrink-0 tabular-nums">
          {hovered.kind === "file" ? "" : `${hovered.fileCount.toLocaleString()} files · `}
          {formatBytes(hovered.bytes)}
        </span>
      ) : null}
    </div>
  );
}
