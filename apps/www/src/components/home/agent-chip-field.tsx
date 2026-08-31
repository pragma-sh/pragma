"use client";

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import {
  CanvasTexture,
  type Group,
  LinearFilter,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from "three";

import { AGENT_BRANDS, type AgentBrand } from "./agents";
import {
  type ChipBody,
  type ExclusionRect,
  planField,
  releaseChip,
  stepChips,
} from "./chip-physics";

/** Chip face size (world units) and its extrusion depth. */
const CHIP_SIZE = 0.7;
const CHIP_DEPTH = 0.2;
const CHIP_RADIUS = CHIP_SIZE * 0.7;
/** Texture resolution each brand mark is rasterised at. */
const TEXTURE_SIZE = 512;
/** Default share of the canvas the hero screenshot occupies. */
const DEFAULT_EXCLUSION = { x: 0.52, y: 0.46 };
/**
 * Size multiplier for the n-th chip. `AGENT_BRANDS` is ordered by prominence and
 * seated two per row (right, then left), so the size is keyed to the *row* — the
 * two chips of a row always match and the field stays mirror-symmetric.
 */
const PROMINENT_ROWS = 2;
const PROMINENT_SCALE = 1.4;
function chipScale(index: number): number {
  const row = Math.floor(index / 2);
  if (row >= PROMINENT_ROWS) return 1;
  return PROMINENT_SCALE - ((PROMINENT_SCALE - 1) * row) / PROMINENT_ROWS;
}

/**
 * How much of a frame's measured drag speed feeds the carried chip's velocity.
 * Smoothing here is what makes a flick read as a throw instead of the single
 * (often near-zero) delta of whatever frame the pointer happened to lift on.
 */
const CARRY_SMOOTHING = 0.45;

/** Farthest (world units) the cursor can lean the field away from its slots. */
const DRIFT_LIMIT = 1.1;
/** Share of the lean retained each second once the cursor stops moving. */
const DRIFT_RETURN = 0.12;
/** How quickly the field catches up to the lean; low is the "slow pull". */
const DRIFT_FOLLOW = 2.4;
/** How far above the hero the chips start their page-load drop, in world units. */
const DROP_HEIGHT = 2.2;
/** Delay between one chip's drop and the next, in seconds. */
const DROP_STAGGER = 0.09;
/**
 * How far toward the camera the most prominent chips ride, and the amplitude of
 * every chip's idle bob. Together they are the farthest a chip is ever drawn in
 * front of the plane `viewport` was measured on.
 */
const PROMINENCE_DEPTH = 1.2;
const IDLE_DEPTH = 0.12;
const MAX_CHIP_DEPTH = (PROMINENT_SCALE - 1) * PROMINENCE_DEPTH + IDLE_DEPTH;

/**
 * Springiness the drop lands with. Kept low on purpose: the chips read as
 * falling into place, not as bouncing around above it. Near 1 the chip
 * overshoots its slot by several units and lands in a neighbour's lap.
 */
const ENTRANCE_BOUNCE = 0.12;

/**
 * Share of the shorter fragment's height two rectangles must overlap vertically
 * to count as the same line of content.
 */
const LINE_MERGE_OVERLAP = 0.5;

/** Stable empty default for `exclusionRefs`, so the prop keeps referential equality. */
const NO_EXCLUSIONS: readonly RefObject<HTMLElement | null>[] = [];

/** Draws `image` centred and contained inside the square texture canvas. */
function drawContained(context: CanvasRenderingContext2D, image: HTMLImageElement): void {
  const ratio = image.naturalWidth > 0 ? image.naturalWidth / image.naturalHeight : 1;
  const inset = TEXTURE_SIZE * 0.66;
  const width = ratio >= 1 ? inset : inset * ratio;
  const height = ratio >= 1 ? inset / ratio : inset;
  context.drawImage(image, (TEXTURE_SIZE - width) / 2, (TEXTURE_SIZE - height) / 2, width, height);
}

/** Rasterises a loaded image into a texture. `null` when 2D canvas is missing. */
function rasterise(image: HTMLImageElement): Texture | null {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  drawContained(context, image);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Rasterises a brand mark into a square canvas texture. Going through a canvas
 * (rather than `TextureLoader`) is deliberate: several marks are SVGs without an
 * intrinsic `width`/`height`, which browsers otherwise size inconsistently.
 */
function loadLogoTexture(source: string): Promise<Texture | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.addEventListener("load", () => resolve(rasterise(image)));
    image.addEventListener("error", () => resolve(null));
    image.src = source;
  });
}

/** Loads every brand mark once and returns them keyed by agent id. */
function useLogoTextures(): Map<string, Texture> {
  const [textures, setTextures] = useState<Map<string, Texture>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        AGENT_BRANDS.map(async (brand) => [brand.id, await loadLogoTexture(brand.logo)] as const),
      );
      if (cancelled) return;
      setTextures(
        new Map(entries.filter((entry): entry is [string, Texture] => entry[1] !== null)),
      );
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => textures.forEach((texture) => texture.dispose()), [textures]);

  return textures;
}

/** One extruded, beveled chip carrying an agent's mark on both faces. */
function AgentChip({ brand, texture }: { brand: AgentBrand; texture: Texture | undefined }) {
  const faceOffset = CHIP_DEPTH / 2 + 0.002;

  return (
    <group>
      <RoundedBox
        args={[CHIP_SIZE, CHIP_SIZE, CHIP_DEPTH]}
        radius={CHIP_SIZE * 0.22}
        smoothness={4}
        creaseAngle={0.5}
      >
        <meshPhysicalMaterial
          color="#121317"
          metalness={0.55}
          roughness={0.32}
          clearcoat={0.9}
          clearcoatRoughness={0.25}
          emissive={brand.tint}
          emissiveIntensity={0.06}
        />
      </RoundedBox>
      {texture ? (
        <>
          <mesh position={[0, 0, faceOffset]}>
            <planeGeometry args={[CHIP_SIZE * 0.98, CHIP_SIZE * 0.98]} />
            <meshBasicMaterial map={texture} transparent toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, -faceOffset]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[CHIP_SIZE * 0.98, CHIP_SIZE * 0.98]} />
            <meshBasicMaterial map={texture} transparent toneMapped={false} />
          </mesh>
        </>
      ) : null}
    </group>
  );
}

/** One line of content, as the box every fragment of it paints into. */
interface LineBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Whether `rect` sits on the same line as the box being built. */
function sharesLine(line: LineBox, rect: DOMRect): boolean {
  const overlap = Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top);
  return overlap > Math.min(line.bottom - line.top, rect.height) * LINE_MERGE_OVERLAP;
}

/** Whether a rectangle covers any pixels at all. */
function isPainted(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Merges client rects down to one box per line. Fragments of one line arrive as
 * separate rectangles (a styled span, each button of a row), so they are merged
 * by vertical overlap rather than by an exact top: a superscript or a taller
 * button shares its line without sharing its box.
 */
function mergeLines(rects: readonly DOMRect[]): LineBox[] {
  const lines: LineBox[] = [];
  for (const rect of rects) {
    const line = lines[lines.length - 1];
    if (line && sharesLine(line, rect)) {
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      continue;
    }
    lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
  }
  return lines;
}

/** Clips a line box to its element's own layout box. */
function clipToBox(line: LineBox, box: DOMRect): DOMRect {
  const left = Math.max(box.left, line.left);
  const right = Math.min(box.right, line.right);
  const top = Math.max(box.top, line.top);
  const bottom = Math.min(box.bottom, line.bottom);
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The boxes an element's content actually paints into: one rectangle per line
 * of it, each clamped to the element's own layout box.
 *
 * Per line, not one union, because the union of a two-line balanced heading is
 * a rectangle as wide as its longest line and as tall as both — which buries
 * exactly the notch beside the short line that the chips should be curling
 * into. Handing the field the real staircase is what makes the band bend around
 * the heading instead of riding flat across the top of it.
 */
function contentRects(element: HTMLElement): DOMRect[] {
  const box = element.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = Array.from(range.getClientRects())
    .filter(isPainted)
    .toSorted((a, b) => a.top - b.top);
  if (rects.length === 0) return [box];

  const clamped = mergeLines(rects)
    .map((line) => clipToBox(line, box))
    .filter(isPainted);
  return clamped.length > 0 ? clamped : [box];
}

/** What the pointer is holding, and where on the chip the grab landed. */
interface Grab {
  index: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Identifies a seating by the geometry it was planned from, rounded to a
 * twentieth of a world unit. Re-seating only when this changes is what lets the
 * entrance animation settle into stable home slots instead of re-seating every
 * frame.
 */
function seatingKey(
  exclusions: readonly ExclusionRect[],
  bounds: { x: number; y: number },
): string {
  return [
    ...exclusions.flatMap((rect) =>
      [rect.centerX, rect.centerY, rect.halfX, rect.halfY].map((value) => Math.round(value * 20)),
    ),
    Math.round(bounds.x * 20),
    Math.round(bounds.y * 20),
  ].join(":");
}

/**
 * Moves every chip's home onto a freshly planned layout, at the scale it was
 * planned at, so the physics radius and the drawn mesh always agree.
 */
function seatBodies(
  bodies: ChipBody[],
  homes: readonly { x: number; y: number }[],
  scale: number,
): void {
  bodies.forEach((body, index) => {
    body.r = CHIP_RADIUS * chipScale(index) * scale;
    const home = homes[index];
    if (!home) return;
    body.homeX = home.x;
    body.homeY = home.y;
    // A re-seat is a fresh layout, so chips that had been knocked out of
    // place rejoin it rather than keeping wherever they were left.
    body.adrift = false;
  });
}

/**
 * Parks every chip above the hero for the page-load entrance, so each one drops
 * onto its own slot: staggered, and springy enough to bounce.
 */
function stageDrop(
  bodies: ChipBody[],
  homes: readonly { x: number; y: number }[],
  ceiling: number,
): void {
  bodies.forEach((body, index) => {
    const home = homes[index];
    if (!home) return;
    body.x = home.x;
    body.y = ceiling + DROP_HEIGHT;
    // Teleporting a chip means its old position is meaningless as a sweep
    // origin — a segment from it would cross rectangles the chip never
    // travelled through.
    body.prevX = body.x;
    body.prevY = body.y;
    body.vx = 0;
    body.vy = 0;
    body.bounce = ENTRANCE_BOUNCE;
    // Bottom slots drop first. Dropping top-down instead lets each chip
    // overshoot into the empty slot below it and get buried by the next one,
    // which lands the whole lane in reverse order.
    body.delay = (bodies.length - 1 - index) * DROP_STAGGER;
    // No entrance spin: a chip that arrives turning spends the next few
    // seconds rocking back to square, which reads as broken rather than
    // playful. It falls flat and lands flat.
    body.angle = 0;
    body.spin = 0;
  });
}

/**
 * Plans a seating for the measured geometry and applies it, dropping the chips
 * in from above when this is the first one. Returns the scale it seated at.
 *
 * Planning from real per-chip radii matters: seating the oversized prominent
 * chips on slots sized for a plain one leaves them permanently overlapping,
 * which the collision solver and the home spring then argue about every frame.
 */
function reseat(
  bodies: ChipBody[],
  bounds: { x: number; y: number },
  exclusions: readonly ExclusionRect[],
  drop: boolean,
): number {
  const { scale, homes } = planField(
    bodies.map((_body, index) => CHIP_RADIUS * chipScale(index)),
    bounds,
    exclusions,
  );
  seatBodies(bodies, homes, scale);
  if (drop) stageDrop(bodies, homes, bounds.y);
  return scale;
}

/**
 * Leans the field by the distance the cursor just travelled, then eases it back
 * once the cursor stops. Feeding one shared offset (instead of a per-chip
 * proximity force) is what keeps a moving cursor from buzzing individual chips
 * against their slots.
 */
function advanceDrift(
  target: { x: number; y: number },
  drift: { x: number; y: number },
  travel: { x: number; y: number } | null,
  step: number,
): void {
  if (travel) {
    target.x += travel.x;
    target.y += travel.y;
    const reach = Math.hypot(target.x, target.y);
    if (reach > DRIFT_LIMIT) {
      target.x *= DRIFT_LIMIT / reach;
      target.y *= DRIFT_LIMIT / reach;
    }
  }
  const settle = DRIFT_RETURN ** step;
  target.x *= settle;
  target.y *= settle;
  const follow = 1 - Math.exp(-DRIFT_FOLLOW * step);
  drift.x += (target.x - drift.x) * follow;
  drift.y += (target.y - drift.y) * follow;
}

/**
 * Carries the held chip on the cursor and reads its throw velocity back off the
 * distance it actually covered, so a bounce against the UI kills the toss the
 * same way a real collision would.
 */
function carryDragged(
  bodies: ChipBody[],
  grab: Grab | null,
  world: { x: number; y: number },
  step: number,
): void {
  if (!grab) return;
  const body = bodies[grab.index];
  if (!body) return;
  const targetX = world.x + grab.offsetX;
  const targetY = world.y + grab.offsetY;
  body.vx = body.vx * (1 - CARRY_SMOOTHING) + ((targetX - body.x) / step) * CARRY_SMOOTHING;
  body.vy = body.vy * (1 - CARRY_SMOOTHING) + ((targetY - body.y) / step) * CARRY_SMOOTHING;
  body.x = targetX;
  body.y = targetY;
  body.free = 1;
}

/** Writes the simulated state onto the drawn groups. */
function paintChips(
  bodies: readonly ChipBody[],
  groups: readonly (Group | null)[],
  time: number,
  fieldScale: number,
): void {
  bodies.forEach((body, index) => {
    const group = groups[index];
    if (!group) return;
    group.scale.setScalar(chipScale(index) * fieldScale);
    group.position.set(
      body.x,
      body.y,
      // Prominent chips ride nearer the camera, so they read as the front row.
      // Keyed to prominence alone — folding in the compact scale would push
      // every chip *away* from the camera in band mode.
      (chipScale(index) - 1) * PROMINENCE_DEPTH + Math.sin(time * 0.08 + body.tumble) * IDLE_DEPTH,
    );
    // Idle tumble stays shallow so a settled chip reads as facing the viewer;
    // the z term is the physics angle, which springs back to upright.
    group.rotation.set(
      Math.sin(time * 0.07 + body.tumble) * 0.05,
      Math.sin(time * 0.05 + body.tumble) * 0.09,
      body.angle,
    );
  });
}

/** Simulated field of chips; owns the body array and drives the group transforms. */
function ChipField({
  exclusionRatio,
  exclusionRefs,
}: {
  exclusionRatio: { x: number; y: number };
  exclusionRefs: readonly RefObject<HTMLElement | null>[];
}) {
  const textures = useLogoTextures();
  const { viewport, pointer, gl } = useThree();
  const groups = useRef<(Group | null)[]>([]);
  /**
   * Uniform size the seating fitted the chips to. 1 in the side gutters of a
   * wide hero; smaller in the shallower bands a narrow one seats them in.
   */
  const fieldScale = useRef(1);
  const pointerWorld = useRef(new Vector3());
  const exclusions = useRef<ExclusionRect[]>([]);
  const seatedFor = useRef("");
  /** The chip currently under the pointer, and where on it the grab landed. */
  const drag = useRef<Grab | null>(null);
  /** Cursor position last frame; `null` until the first frame establishes one. */
  const previousPointer = useRef<{ x: number; y: number } | null>(null);
  /** Where the field wants to lean, and where it has actually leaned so far. */
  const driftTarget = useRef({ x: 0, y: 0 });
  const drift = useRef({ x: 0, y: 0 });
  /** Whether the page-load drop has been staged. */
  const dropped = useRef(false);

  const bodies = useMemo<ChipBody[]>(
    () =>
      AGENT_BRANDS.map((_brand, index) => {
        const angle = (index / AGENT_BRANDS.length) * Math.PI * 2 - Math.PI / 2;
        return {
          x: Math.cos(angle) * 4,
          y: Math.sin(angle) * 2.2,
          vx: 0,
          vy: 0,
          r: CHIP_RADIUS * chipScale(index),
          homeX: Math.cos(angle) * 4,
          homeY: Math.sin(angle) * 2.2,
          // Square from the first frame: the uprighting spring pulls every chip
          // to 0 anyway, and any start angle just reads as a chip that landed
          // crooked and took a moment to right itself.
          angle: 0,
          spin: 0,
          tumble: Math.random() * Math.PI * 2,
          held: false,
          free: 0,
          bounce: 0,
          delay: 0,
          adrift: false,
          prevX: Math.cos(angle) * 4,
          prevY: Math.sin(angle) * 2.2,
        };
      }),
    [],
  );

  /**
   * Ends a drag wherever the pointer goes up — including outside the canvas, so
   * a chip flung off the hero is still released rather than stuck to the cursor.
   */
  useEffect(() => {
    const stop = () => {
      const active = drag.current;
      drag.current = null;
      document.body.style.cursor = "";
      if (!active) return;
      const body = bodies[active.index];
      if (body) releaseChip(body, body.vx, body.vy);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      stop();
    };
  }, [bodies]);

  /**
   * Measures each protected element in world units. Reading the live rects
   * (rather than assuming fractions of the canvas) is what keeps the exclusion
   * zones glued to the copy block and the screenshot through their entrance
   * animations and any layout change.
   */
  const measureExclusions = (): ExclusionRect[] => {
    const canvas = gl.domElement.getBoundingClientRect();
    const elements = exclusionRefs
      .map((ref) => ref.current)
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0 || canvas.width === 0 || canvas.height === 0) {
      return [
        {
          centerX: 0,
          centerY: 0,
          halfX: (viewport.width / 2) * exclusionRatio.x,
          halfY: (viewport.height / 2) * exclusionRatio.y,
        },
      ];
    }
    const scaleX = viewport.width / canvas.width;
    const scaleY = viewport.height / canvas.height;
    return elements.flatMap((element) =>
      contentRects(element).map((rect) => ({
        centerX: (rect.left + rect.width / 2 - (canvas.left + canvas.width / 2)) * scaleX,
        centerY: -(rect.top + rect.height / 2 - (canvas.top + canvas.height / 2)) * scaleY,
        halfX: (rect.width / 2) * scaleX,
        halfY: (rect.height / 2) * scaleY,
      })),
    );
  };

  useFrame((state, delta) => {
    exclusions.current = measureExclusions();

    // `viewport` measures the plane at z = 0, but a chip is drawn in front of
    // it, and a perspective camera magnifies whatever is nearer — position
    // included. Seating a crest chip against the raw half-height therefore
    // projects it *past* the canvas edge, which is what sliced the top off the
    // band's arc right under the nav. Shrinking the bounds by that same factor
    // makes the seating and the physics work in the box the chips actually
    // land in.
    const cameraZ = state.camera.position.z;
    const parallax = cameraZ / Math.max(cameraZ - MAX_CHIP_DEPTH, 0.001);
    const bounds = { x: viewport.width / 2 / parallax, y: viewport.height / 2 / parallax };

    const key = seatingKey(exclusions.current, bounds);
    if (key !== seatedFor.current) {
      seatedFor.current = key;
      fieldScale.current = reseat(bodies, bounds, exclusions.current, !dropped.current);
      dropped.current = true;
    }

    const world = pointerWorld.current.set(
      (pointer.x * viewport.width) / 2,
      (pointer.y * viewport.height) / 2,
      0,
    );

    const step = Math.max(Math.min(delta, 1 / 30), 1 / 240);
    const previous = previousPointer.current;
    const travel = previous ? { x: world.x - previous.x, y: world.y - previous.y } : null;
    previousPointer.current = { x: world.x, y: world.y };
    advanceDrift(driftTarget.current, drift.current, travel, step);
    carryDragged(bodies, drag.current, world, step);

    stepChips(bodies, delta, {
      bounds,
      drift: drift.current,
      exclusions: exclusions.current,
    });

    paintChips(bodies, groups.current, state.clock.elapsedTime, fieldScale.current);
  });

  return (
    <>
      {AGENT_BRANDS.map((brand, index) => (
        <group
          key={brand.id}
          ref={(node) => {
            groups.current[index] = node;
          }}
          onPointerDown={(event) => {
            const body = bodies[index];
            if (!body) return;
            event.stopPropagation();
            gl.domElement.setPointerCapture(event.pointerId);
            body.held = true;
            body.free = 1;
            drag.current = {
              index,
              // Grab offset, so the chip does not snap its centre to the cursor.
              offsetX: body.x - pointerWorld.current.x,
              offsetY: body.y - pointerWorld.current.y,
            };
            document.body.style.cursor = "grabbing";
          }}
          onPointerOver={() => {
            if (!drag.current) document.body.style.cursor = "grab";
          }}
          onPointerOut={() => {
            if (!drag.current) document.body.style.cursor = "";
          }}
        >
          <AgentChip brand={brand} texture={textures.get(brand.id)} />
        </group>
      ))}
    </>
  );
}

/**
 * Full-bleed canvas of floating agent chips behind the hero. `exclusionRefs`
 * point at the elements the chips must never cover — the copy block and the
 * product screenshot — and the field lays itself out in whatever space is left.
 * `exclusionRatio` is only the fallback used before those are measurable.
 */
export function AgentChipField({
  className,
  exclusionRatio = DEFAULT_EXCLUSION,
  exclusionRefs = NO_EXCLUSIONS,
}: {
  className?: string;
  exclusionRatio?: { x: number; y: number };
  exclusionRefs?: readonly RefObject<HTMLElement | null>[];
}) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // Width no longer gates the field: a narrow viewport seats it in bands above
    // and below the hero instead of beside it. Only a reduced-motion preference
    // drops it, since the whole point of the field is that it moves.
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setEnabled(!motionQuery.matches);
    sync();
    motionQuery.addEventListener("change", sync);
    return () => motionQuery.removeEventListener("change", sync);
  }, []);

  if (!enabled) return null;

  return (
    <div className={className} aria-hidden>
      <Canvas camera={{ position: [0, 0, 9], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[5, 6, 8]} intensity={2.4} />
        <directionalLight position={[-6, -3, 4]} intensity={0.9} color="#ffffff" />
        <pointLight position={[0, 0, 6]} intensity={22} color="#f2f2f2" distance={18} />
        <ChipField exclusionRatio={exclusionRatio} exclusionRefs={exclusionRefs} />
      </Canvas>
    </div>
  );
}
