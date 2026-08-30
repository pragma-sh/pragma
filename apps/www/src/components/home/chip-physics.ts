/**
 * Pure 2D physics for the hero's floating agent chips. The field is *anchored*:
 * every chip owns a fixed home slot (the array is ordered by prominence, so the
 * most-used agents take the top slots) and springs back to it. The cursor only
 * nudges chips a little, but a chip can be grabbed and thrown, which puts it in
 * a temporarily "free" state where it flies, crashes into its neighbours, and
 * bounces off the protected UI rectangles before drifting home again.
 *
 * No three.js types here so the simulation stays testable and framework-free.
 */

/** Axis-aligned rectangle in world units. */
export interface ExclusionRect {
  /** Centre of the rectangle. */
  centerX: number;
  centerY: number;
  /** Half-extents. */
  halfX: number;
  halfY: number;
}

/** A single simulated chip. Positions and velocities are in world units. */
export interface ChipBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Collision radius. */
  r: number;
  /** Rest position the chip drifts back to. */
  homeX: number;
  homeY: number;
  /** Spin about the chip's own axis, in radians and radians/second. */
  angle: number;
  spin: number;
  /** Slow tumble used for the chip's secondary axis. */
  tumble: number;
  /**
   * `true` while the pointer is dragging this chip. A held chip is driven
   * directly by the scene and behaves as immovable in every collision.
   */
  held: boolean;
  /**
   * How "thrown" the chip currently is, in `[0, 1]`. At 1 the home spring is
   * off and damping is light, so a toss actually flies; it decays back to 0,
   * which re-engages the spring and settles the chip on its slot.
   */
  free: number;
  /**
   * How "springy" the chip currently is, in `[0, 1]`. Unlike `free` it leaves
   * the home spring at full strength and only lightens damping, so the chip
   * overshoots its slot and rings down — this is what makes the entrance drop
   * bounce. Decays to 0, where the spring is near-critically damped and the
   * chip is dead still.
   */
  bounce: number;
  /** Seconds this chip stays frozen before it joins the simulation. */
  delay: number;
  /**
   * `true` once a chip has been thrown or struck by one that was. Its home slot
   * follows it while it travels, so it comes to rest wherever the collision left
   * it instead of filing back to the slot it was seated in. Cleared when the
   * chip parks, which re-anchors it there.
   */
  adrift: boolean;
  /**
   * Last position the solver signed off on. Every move — integrated, collided,
   * or dragged straight from the cursor — is swept from here, which is what
   * makes "never under the UI" a property of the *path* rather than of where
   * the chip happened to land at the end of a frame.
   */
  prevX: number;
  prevY: number;
}

/** Per-frame inputs the simulation reads from the scene. */
export interface StepOptions {
  /** Half-extents of the visible area, in world units. */
  bounds: { x: number; y: number };
  /**
   * Shared offset applied to every home slot, in world units. The scene feeds
   * cursor travel in here, so the whole field leans the way the cursor went
   * instead of each chip reacting to its own distance from it.
   */
  drift: { x: number; y: number };
  /** Rectangles (screenshot, copy block) the chips must stay off. */
  exclusions: readonly ExclusionRect[];
}

/**
 * Clearance kept between a chip and any excluded rectangle, as a multiple of
 * the chip's own radius. Proportional rather than absolute so the small chips
 * a narrow viewport uses do not reserve a gutter sized for the large ones.
 */
const EXCLUSION_MARGIN_RATIO = 1.1;
/** Clearance a chip of `radius` keeps from any excluded rectangle. */
function margin(radius: number): number {
  return radius * EXCLUSION_MARGIN_RATIO;
}
/** Pull back toward the chip's home slot, once the chip is done being thrown. */
const HOME_SPRING = 11;
/** Velocity retained each second while a chip sits on its slot: near-critical. */
const SETTLED_DAMPING = 0.02;
/** Velocity retained each second while a chip is flying from a toss. */
const FREE_DAMPING = 0.72;
/** How fast the thrown state decays; 0.45 ≈ 2.2s of free flight. */
const FREE_DECAY = 0.45;
/** How fast the springy state decays; 0.35 ≈ 2.9s of ring-down after a drop. */
const BOUNCE_DECAY = 0.35;
/**
 * Gap between two seated chips, as a share of their combined radii. Like the
 * exclusion margin it is proportional, so a lane of shrunken chips does not
 * reserve the whitespace a lane of full-size ones would.
 */
const SLOT_GAP_RATIO = 0.3;
/**
 * How much the chips may shrink before the side gutters are abandoned for bands
 * above and below the hero. Above this they still read as a column beside the
 * content; below it they would be specks in a sliver.
 */
const SIDE_MIN_SCALE = 0.8;
/** Hard floor on the fitted scale — past this the chips stop being legible. */
const MIN_SCALE = 0.3;
/** Farthest a slot is scattered off its lane's centre line, in world units. */
const STAGGER_MAX = 0.45;
/** Speed below which an adrift chip is considered parked, in world units/s. */
const PARK_SPEED = 0.08;
/** Speed ceiling; high enough for a real toss, low enough to stay on screen. */
const MAX_SPEED = 26;
/** Restitution used for chip-to-chip, wall, and UI bounces. */
const RESTITUTION = 0.72;
/**
 * Fraction of a collision impulse converted into spin. Kept low deliberately:
 * a lane of chips landing on its slots trades a lot of small impulses, and at a
 * high transfer the whole field arrives twirling.
 */
const SPIN_TRANSFER = 0.22;
/** Fraction of a bounce's tangential speed converted into spin. */
const BOUNCE_SPIN = 0.1;
/**
 * Torque pulling a chip's face back to upright, so a stirred field always
 * settles square rather than parking at whatever angle it was flung to.
 */
const UPRIGHT_SPRING = 7;
/**
 * Spin retained each second; damps the uprighting spring so it does not ring.
 * Paired with the spring above this sits near a damping ratio of 0.75 — a chip
 * knocked askew straightens in about a second instead of rocking for three.
 */
const SPIN_DAMPING = 0.02;
/** Ceiling on how fast a chip may turn, in radians/second. */
const MAX_SPIN = 2.4;
/**
 * Farthest a chip may lean off square, in radians. A settling chip is allowed a
 * tilt, never a revolution — past this the turn simply stops, which is what
 * keeps the entrance from reading as a handful of spinning coins.
 */
const MAX_TILT = 0.5;
/** Tilt allowed instead while a chip is mid-throw, so a toss still tumbles. */
const THROWN_TILT = Math.PI;
/** Speed above which a release counts as a throw rather than a place-down. */
const THROW_SPEED = 1.2;
/** Longest distance a chip may travel in one solver substep, in world units. */
const SWEEP_STEP = 0.12;
/** Ceiling on substeps per frame, so a stalled tab cannot melt the CPU. */
const MAX_SUBSTEPS = 8;
/** Gap left between a chip and a surface it was swept onto, in world units. */
const SURFACE_EPSILON = 0.001;

function clampSpeed(body: ChipBody): void {
  const speed = Math.hypot(body.vx, body.vy);
  if (speed <= MAX_SPEED) return;
  const scale = MAX_SPEED / speed;
  body.vx *= scale;
  body.vy *= scale;
}

/** Linear blend, used to fade damping between the free and settled regimes. */
function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Constrains `value` to `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Stops a chip on the face of `rect` it would have crossed on its way from
 * (`prevX`, `prevY`) to its current position, and reflects the velocity on that
 * axis. Returns `true` when it intervened.
 *
 * This is the primary guard, and it is swept rather than positional on purpose.
 * Resolving after the move can only ask "which face is nearest *now*", which for
 * a chip that arrived deep inside is the face on the *far* side — so the fix for
 * an overlap was itself a trip underneath the screenshot. Asking "which face did
 * it cross first" has no such failure mode: the chip stops at the surface it hit
 * and never occupies the interior at all.
 */
/**
 * How far a chip has pushed inside `rect`'s clearance outline, plus the unit
 * direction out of it. `null` when the chip is clear.
 *
 * The outline is the rectangle grown by the chip's own clearance and *rounded*
 * over the corners — precisely the Minkowski sum the home slots are seated on.
 * Squaring those corners off instead (a plain padded box) leaves the seats a
 * lane places around a corner permanently illegal, so the solver shoves the chip
 * while its home spring hauls it back: the field buzzes and never settles.
 */
function penetration(
  body: ChipBody,
  rect: ExclusionRect,
): { depth: number; nx: number; ny: number } | null {
  const pad = body.r + margin(body.r);
  const dx = body.x - rect.centerX;
  const dy = body.y - rect.centerY;
  const overX = Math.abs(dx) - rect.halfX;
  const overY = Math.abs(dy) - rect.halfY;
  if (overX >= pad || overY >= pad) return null;
  // Past both faces the nearest point on the rectangle is its corner, so the
  // clearance is measured radially from there rather than per axis.
  if (overX > 0 && overY > 0) {
    const reach = Math.hypot(overX, overY);
    if (reach >= pad) return null;
    const signX = Math.sign(dx) || 1;
    const signY = Math.sign(dy) || 1;
    const span = reach || 1;
    return { depth: pad - reach, nx: (overX / span) * signX, ny: (overY / span) * signY };
  }
  return overX > overY
    ? { depth: pad - overX, nx: Math.sign(dx) || 1, ny: 0 }
    : { depth: pad - overY, nx: 0, ny: Math.sign(dy) || -1 };
}

function sweepExclusion(body: ChipBody, rect: ExclusionRect): boolean {
  const padX = rect.halfX + body.r + margin(body.r);
  const padY = rect.halfY + body.r + margin(body.r);
  const toX = body.x - rect.centerX;
  const toY = body.y - rect.centerY;
  // Not ending up inside the rounded outline: nothing to do. Testing the round
  // outline rather than the box is what leaves a chip seated on a corner alone.
  if (penetration(body, rect) === null) return false;

  const fromX = body.prevX - rect.centerX;
  const fromY = body.prevY - rect.centerY;
  // Already inside when the segment started — the sweep has no entry face to
  // find, so the positional pushout below handles it.
  if (Math.abs(fromX) < padX && Math.abs(fromY) < padY) return false;

  const dx = toX - fromX;
  const dy = toY - fromY;
  // A zero-length segment has no entry face; the pushout below owns that case.
  if (dx === 0 && dy === 0) return false;
  // Entry time per axis: when the segment crossed that axis' near face.
  const entryX = dx === 0 ? -Infinity : (Math.sign(dx) * -padX - fromX) / dx;
  const entryY = dy === 0 ? -Infinity : (Math.sign(dy) * -padY - fromY) / dy;
  // The last face crossed is the one actually entered through.
  const onX = entryX > entryY;
  const entry = Math.min(Math.max(onX ? entryX : entryY, 0), 1);

  if (onX) {
    const face = Math.sign(dx) * -padX;
    body.x = rect.centerX + face - Math.sign(dx) * SURFACE_EPSILON;
    body.y = rect.centerY + fromY + dy * entry;
    if (!body.held) {
      body.vx = -body.vx * RESTITUTION;
      body.spin += body.vy * -Math.sign(dx) * BOUNCE_SPIN;
    }
  } else {
    const face = Math.sign(dy) * -padY;
    body.y = rect.centerY + face - Math.sign(dy) * SURFACE_EPSILON;
    body.x = rect.centerX + fromX + dx * entry;
    if (!body.held) {
      body.vy = -body.vy * RESTITUTION;
      body.spin += body.vx * Math.sign(dy) * BOUNCE_SPIN;
    }
  }
  return true;
}

/**
 * Pushes a chip that is *already* inside `rect` back out — the case the sweep
 * cannot cover, which happens when a rect grows or moves onto a settled chip
 * (an entrance animation, a resize) rather than when a chip moves into a rect.
 *
 * It escapes sideways only when the side gutter is actually wide enough to hold
 * a chip; otherwise it goes above or below, because a sideways escape into a
 * too-narrow gutter is what parks a chip half-under the screenshot.
 */
function applyExclusion(body: ChipBody, rect: ExclusionRect, bounds: StepOptions["bounds"]): void {
  const hit = penetration(body, rect);
  if (!hit) return;

  const dx = body.x - rect.centerX;
  const dy = body.y - rect.centerY;
  // Round the corner rather than choosing an axis: a chip tucked into a corner
  // is only a little way inside, and squaring it out sends it a long way along
  // whichever axis won — which reads as a chip flinching away from the heading.
  if (hit.nx !== 0 && hit.ny !== 0) {
    body.x += hit.nx * hit.depth;
    body.y += hit.ny * hit.depth;
    if (!body.held) {
      const inward = body.vx * hit.nx + body.vy * hit.ny;
      if (inward < 0) {
        body.vx -= (1 + RESTITUTION) * inward * hit.nx;
        body.vy -= (1 + RESTITUTION) * inward * hit.ny;
      }
    }
    return;
  }

  const padX = rect.halfX + body.r + margin(body.r);
  const padY = rect.halfY + body.r + margin(body.r);
  const overlapX = padX - Math.abs(dx);
  const overlapY = padY - Math.abs(dy);
  const dirX = dx === 0 ? 1 : Math.sign(dx);
  const gutter =
    dirX > 0 ? bounds.x - (rect.centerX + rect.halfX) : rect.centerX - rect.halfX + bounds.x;

  if (overlapX <= overlapY && gutter >= 2 * body.r + margin(body.r)) {
    body.x += dirX * overlapX;
    if (!body.held && body.vx * dirX < 0) {
      body.vx = -body.vx * RESTITUTION;
      body.spin += body.vy * dirX * BOUNCE_SPIN;
    }
    return;
  }
  const dirY = dy === 0 ? -1 : Math.sign(dy);
  body.y += dirY * overlapY;
  if (!body.held && body.vy * dirY < 0) {
    body.vy = -body.vy * RESTITUTION;
    body.spin += -body.vx * dirY * BOUNCE_SPIN;
  }
}

/**
 * Keeps one chip inside the viewport and out of every protected rectangle,
 * bouncing it off both. A held chip is repositioned but not re-velocitied — the
 * drag owns its velocity — so dragging one over the screenshot slides it along
 * the edge instead of letting it pass beneath.
 */
function constrain(body: ChipBody, options: StepOptions): void {
  // Entrance chips are parked above the viewport on purpose; clamping them into
  // bounds here would delete the drop before it started.
  if (body.delay > 0) {
    body.prevX = body.x;
    body.prevY = body.y;
    return;
  }
  // Two passes: stopping a chip against one rectangle can slide it into the
  // next, and the copy block and screenshot share a corner where that happens.
  for (let pass = 0; pass < 2; pass += 1) {
    let touched = false;
    for (const rect of options.exclusions) {
      // Sweep first: it stops the chip at the face it crossed. The positional
      // pushout only runs for a chip that was already inside to begin with.
      if (sweepExclusion(body, rect)) {
        touched = true;
      } else {
        applyExclusion(body, rect, options.bounds);
      }
    }
    if (!touched) break;
  }

  const limitX = options.bounds.x - body.r;
  const limitY = options.bounds.y - body.r;
  if (Math.abs(body.x) > limitX) {
    body.x = Math.sign(body.x) * limitX;
    if (!body.held) {
      body.vx *= -RESTITUTION;
      body.spin += body.vy * BOUNCE_SPIN;
    }
  }
  // A chip above the ceiling and moving down is dropping in from off-screen, so
  // it falls through; only an upward escape is bounced back.
  const escapingUp = body.y > limitY && body.vy > 0;
  if (body.y < -limitY || escapingUp) {
    body.y = Math.sign(body.y) * limitY;
    if (!body.held) {
      body.vy *= -RESTITUTION;
      body.spin += -body.vx * BOUNCE_SPIN;
    }
  }

  // This position is now legal, so it becomes the origin the next move sweeps
  // from. Recording it anywhere but here would let an illegal position seed the
  // next sweep and defeat the whole guard.
  body.prevX = body.x;
  body.prevY = body.y;
}

/**
 * Lays a lane of chips out from `from` to `to`, giving each one its own radius
 * plus `SLOT_GAP` of clearance and spreading whatever room is left over evenly.
 *
 * Packing by real radii (rather than dividing the lane into equal steps) is what
 * keeps the field still: equal steps seat the two oversized prominent chips
 * closer than their radii allow, and the resulting permanent overlap makes the
 * collision solver and the home spring fight each other every single frame.
 */
function packLane(
  radii: readonly number[],
  from: number,
  to: number,
  reach: LaneReach = "inset",
): number[] {
  const count = radii.length;
  if (count === 0) return [];
  const span = Math.abs(from - to);
  const direction = Math.sign(to - from) || 1;
  const slack = Math.max(0, span - laneLength(radii));
  // "inset" leaves a margin at both ends as well as between the chips; "ends"
  // spends the whole slack between them, so the outermost chips sit on the
  // lane's own ends. A band uses "ends" because those ends are exactly the part
  // of the lane that curls down beside the content — inset by a full share, the
  // outer chips never reach the corner and the band reads as a flat row.
  const lead = reach === "ends" ? 0 : slack / (count + 1);
  const between = reach === "ends" && count > 1 ? slack / (count - 1) : 0;

  let cursor = from;
  return radii.map((radius, index) => {
    cursor += direction * (lead + radius);
    const position = cursor;
    const next = radii[index + 1];
    cursor +=
      direction * (radius + (next === undefined ? 0 : (radius + next) * SLOT_GAP_RATIO + between));
    return position;
  });
}

/** Whether a packed lane keeps a margin at its ends or runs right up to them. */
type LaneReach = "inset" | "ends";

/** Length a lane of chips occupies once packed, gaps included. */
function laneLength(radii: readonly number[]): number {
  return radii.reduce((total, radius, index) => {
    const next = radii[index + 1];
    return total + 2 * radius + (next === undefined ? 0 : (radius + next) * SLOT_GAP_RATIO);
  }, 0);
}

/** Splits the chips into the two lanes the layouts seat them in. */
function splitLanes<T>(items: readonly T[]): [T[], T[]] {
  return [
    items.filter((_item, index) => index % 2 === 0),
    items.filter((_i, index) => index % 2 === 1),
  ];
}

/**
 * Where the chips seat relative to the protected content: a column down each
 * side gutter, or a band above it and another below.
 */
export type FieldLayout = "side" | "band";

/**
 * Deterministic `[0, 1)` value for a slot. Deterministic and not `Math.random`
 * so a re-seat (resize, entrance animation settling) reproduces the same
 * scatter instead of reshuffling the field under the reader.
 */
function scatter(index: number): number {
  const value = Math.sin((index + 1) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Offsets a slot off its lane's centre line so a lane reads as a scattered
 * column rather than a ruled one. The offset runs from `inward` (toward the
 * protected rectangle, only as far as the chip's own radius is smaller than the
 * lane's widest) to `outward` (toward the viewport edge), so no amount of
 * scatter can push a chip onto the UI.
 */
function stagger(index: number, radius: number, widest: number, room: number): number {
  const inward = Math.min(STAGGER_MAX, Math.max(0, widest - radius));
  const outward = Math.min(STAGGER_MAX, Math.max(0, room));
  return mix(-inward, outward, scatter(index));
}

/** A polyline a lane seats its slots along. */
type LanePath = { x: number; y: number }[];

/**
 * A rectangle in a lane's own frame: `along` runs the way the lane runs,
 * `across` is the direction it is offset in. Working in this frame is what lets
 * one implementation serve both a horizontal band and a vertical column.
 */
interface LaneRect {
  alongCenter: number;
  alongHalf: number;
  acrossCenter: number;
  acrossHalf: number;
}

/** How a lane is oriented relative to the protected content. */
interface LaneShape {
  /** `true` when the lane runs left to right (a band); `false` for a column. */
  horizontal: boolean;
  /** +1 for the lane above or right of the content, -1 for below or left. */
  sign: number;
  /** Clearance the lane keeps from the content — also its corner radius. */
  gap: number;
  /** Half-extents of the viewport along the lane and across it. */
  alongLimit: number;
  acrossLimit: number;
  /**
   * How far the lane may follow the silhouette back past its own crest, in
   * world units. `Infinity` lets it track the outline exactly; a finite cap is
   * what keeps a band *mostly* above the content while still curling a little
   * way down either side of it.
   */
  wrap: number;
}

/**
 * How far a band wraps down the sides of the content, as a multiple of its own
 * clearance. A band is chosen when the side gutters are too thin for a column,
 * so the sides can only hold a little of the lane: enough that the ends read as
 * curling around the heading, not so much that the field stops being a band.
 */
const BAND_WRAP_RATIO = 2.6;
/** Samples a lane path is traced with; corners are only as round as this. */
const LANE_SAMPLES = 96;
/** Sampling distance used to read a lane path's direction, in world units. */
const PATH_EPSILON = 0.01;

/** Re-frames a rectangle for a lane running along the given axis. */
function laneFrame(rect: ExclusionRect, horizontal: boolean): LaneRect {
  return horizontal
    ? {
        alongCenter: rect.centerX,
        alongHalf: rect.halfX,
        acrossCenter: rect.centerY,
        acrossHalf: rect.halfY,
      }
    : {
        alongCenter: rect.centerY,
        alongHalf: rect.halfY,
        acrossCenter: rect.centerX,
        acrossHalf: rect.halfX,
      };
}

/**
 * Where the outline of `rect` offset by `gap` sits at `along`: its near face
 * pushed out by the full gap over the rectangle's own span, then rounded off
 * across the corner. `null` past the corner, where the outline is a straight
 * side that this along-position never meets.
 */
function outlineAt(rect: LaneRect, along: number, gap: number, sign: number): number | null {
  const over = Math.abs(along - rect.alongCenter) - rect.alongHalf;
  if (over >= gap) return null;
  const reach = over <= 0 ? gap : Math.sqrt(gap * gap - over * over);
  return rect.acrossCenter + sign * (rect.acrossHalf + reach);
}

/**
 * Traces the line a lane seats its chips on: the silhouette of everything the
 * chips must avoid, pushed out by `gap` and rounded over every corner.
 *
 * Offsetting the *silhouette* rather than fitting a lane to one rectangle is
 * what makes the field follow the hero's actual shape — a column tucks in beside
 * the narrow heading and bulges back out around the wide screenshot below it,
 * and a band curves down off the heading's corners — all as one continuous
 * curve, with no breakpoint deciding which. Because the Minkowski sum
 * distributes over a union, taking the outermost offset at each step is exactly
 * the outline of the union, corners included.
 *
 * Where no rectangle reaches — above the heading, past the screenshot — the lane
 * falls back to the innermost rectangle's own offset, so it stays a lane instead
 * of collapsing onto the centre line. `shape.wrap` then caps how far back past
 * the lane's own crest the outline may pull it, which is what keeps a band from
 * diving the full way down beside a narrow heading.
 */
function lanePath(exclusions: readonly ExclusionRect[], shape: LaneShape): LanePath {
  const rects = exclusions.map((rect) => laneFrame(rect, shape.horizontal));
  const offsets = rects.map(
    (rect) => rect.acrossCenter + shape.sign * (rect.acrossHalf + shape.gap),
  );
  const inner = shape.sign > 0 ? Math.min(...offsets) : Math.max(...offsets);
  const outermost = (best: number, reach: number) =>
    shape.sign * reach > shape.sign * best ? reach : best;
  // The lane's crest: the offset of whichever rectangle sits nearest the lane.
  // Everything the lane does past its corners is measured back from here.
  const crest = offsets.reduce(outermost, inner);
  const wrapLimit = crest - shape.sign * shape.wrap;
  // Bands read left to right and columns top to bottom, so the chips' own
  // prominence order runs the way the page does either way.
  const from = shape.horizontal ? -shape.alongLimit : shape.alongLimit;

  return Array.from({ length: LANE_SAMPLES + 1 }, (_unused, step) => {
    const along = mix(from, -from, step / LANE_SAMPLES);
    const reaches = rects
      .map((rect) => outlineAt(rect, along, shape.gap, shape.sign))
      .filter((reach): reach is number => reach !== null);
    const tracked = reaches.reduce(outermost, inner);
    const capped = shape.sign > 0 ? Math.max(tracked, wrapLimit) : Math.min(tracked, wrapLimit);
    const across = clamp(capped, -shape.acrossLimit, shape.acrossLimit);
    return shape.horizontal ? { x: along, y: across } : { x: across, y: along };
  });
}

/** Total length of a lane path, in world units. */
function pathLength(path: LanePath): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    if (!from || !to) continue;
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

/** The point `distance` along a lane path, clamped to its two ends. */
function pointOnPath(path: LanePath, distance: number): { x: number; y: number } {
  const first = path[0] ?? { x: 0, y: 0 };
  let left = Math.max(0, distance);
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    if (!from || !to) continue;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (span <= 0) continue;
    if (left <= span) {
      return { x: mix(from.x, to.x, left / span), y: mix(from.y, to.y, left / span) };
    }
    left -= span;
  }
  return path[path.length - 1] ?? first;
}

/**
 * One seat on a lane path: where it sits, plus the unit normal pointing away
 * from the content. Slots scatter along that normal, so the jitter reads as
 * depth on the flat top *and* on the wrapped sides instead of only vertically.
 */
function pathSlot(
  path: LanePath,
  distance: number,
  sign: number,
): { x: number; y: number; nx: number; ny: number } {
  const point = pointOnPath(path, distance);
  const behind = pointOnPath(path, distance - PATH_EPSILON);
  const ahead = pointOnPath(path, distance + PATH_EPSILON);
  const dx = ahead.x - behind.x;
  const dy = ahead.y - behind.y;
  const span = Math.hypot(dx, dy) || 1;
  return { x: point.x, y: point.y, nx: (-dy / span) * sign, ny: (dx / span) * sign };
}

/**
 * Places one home slot per chip in the space left over by the excluded
 * rectangles: a column down each side gutter when the viewport is wide enough
 * to hold one, otherwise a lane above the content and another below it.
 *
 * Either way the lane follows the content's offset silhouette rather than a
 * straight line, so it leans in wherever the content is narrow — a column tucks
 * toward the heading before bulging back around the screenshot, and a band
 * curves down off the heading's corners. `radii` is per chip, in the array's own
 * prominence order.
 */
export function planHomes(
  radii: readonly number[],
  bounds: StepOptions["bounds"],
  exclusions: readonly ExclusionRect[],
  layout?: FieldLayout,
): { x: number; y: number }[] {
  const count = radii.length;
  if (count === 0) return [];
  const widest = Math.max(...radii);
  const limitX = bounds.x - widest;
  const limitY = bounds.y - widest;
  if (exclusions.length === 0) {
    return Array.from({ length: count }, (_unused, index) => {
      const angle = Math.PI / 2 - (index / count) * Math.PI * 2;
      return { x: Math.cos(angle) * limitX * 0.82, y: Math.sin(angle) * limitY * 0.78 };
    });
  }

  const left = Math.min(...exclusions.map((rect) => rect.centerX - rect.halfX));
  const right = Math.max(...exclusions.map((rect) => rect.centerX + rect.halfX));
  const clearance = 2 * widest + margin(widest);
  const sideFits =
    layout === undefined
      ? Math.min(bounds.x - right, left + bounds.x) >= clearance
      : layout === "side";

  // Even indices take the right lane (or the upper band), odd the left, so the
  // prominence order reads the way the page does on both.
  const lanes = splitLanes(radii.map((radius, index) => ({ radius, index })));
  const homes: { x: number; y: number }[] = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  const gap = widest + margin(widest);
  // A column runs down the height and is offset across the width; a band is the
  // same thing with the axes swapped.
  const alongLimit = sideFits ? limitY : limitX;
  const acrossLimit = sideFits ? limitX : limitY;

  // A band is *one* arc over the content, walked outward from its middle by
  // both lanes, rather than a lane above the content and a second one below it.
  // The lower band was never reachable: it sits under the screenshot, which is
  // the tallest thing on the page, so the chips seated there spent forever
  // pressed against its underside with the home spring still pulling — that
  // permanent stand-off is what the field reads as a vibration. Everything
  // above the content is reachable from anywhere, so the arc always settles.
  const bandPath = sideFits
    ? null
    : lanePath(exclusions, {
        horizontal: true,
        sign: 1,
        gap,
        alongLimit,
        acrossLimit,
        wrap: gap * BAND_WRAP_RATIO,
      });
  const bandMiddle = bandPath ? pathLength(bandPath) / 2 : 0;

  lanes.forEach((lane, parity) => {
    const laneRadii = lane.map((slot) => slot.radius);
    // Which way "outward" points for this lane: toward the nearer viewport edge.
    const away = parity === 0 ? 1 : -1;
    const path =
      bandPath ??
      lanePath(exclusions, {
        horizontal: false,
        sign: away,
        gap,
        alongLimit,
        acrossLimit,
        wrap: Infinity,
      });
    // A band's two lanes share one path and split it at the middle, so the
    // prominent chips crown the heading and the rest walk down either side. The
    // half-gap keeps the two innermost chips off each other's slot.
    const from = bandPath ? bandMiddle + away * widest * SLOT_GAP_RATIO : 0;
    const to = bandPath ? (away > 0 ? pathLength(path) : 0) : pathLength(path);
    const reach: LaneReach = sideFits ? "inset" : "ends";
    // The normal points away from the content on both halves of a band; only a
    // column flips it to face its own side of the hero.
    const facing = bandPath ? 1 : away;
    // Outward scatter is sized once, from the room left over its crest — the
    // part of the lane nearest the viewport edge. Sizing it per slot instead
    // would hand the most room to the slots on the lane's wrapped ends, which
    // are low precisely because the content leaves room there, and floating
    // them back up to the ceiling is what flattens the curve out again.
    const crestRoom =
      acrossLimit - Math.max(...path.map((point) => Math.abs(sideFits ? point.x : point.y)));
    packLane(laneRadii, from, to, reach).forEach((distance, slot) => {
      const target = lane[slot];
      if (!target) return;
      const seat = pathSlot(path, distance, facing);
      // Scatter runs along the path's own normal, so it reads as depth wherever
      // the lane happens to be pointing rather than only on its straight runs.
      const offset = stagger(target.index, target.radius, widest, crestRoom);
      homes[target.index] = {
        x: clamp(seat.x + seat.nx * offset, -limitX, limitX),
        y: clamp(seat.y + seat.ny * offset, -limitY, limitY),
      };
    });
  });

  return homes;
}

/**
 * Chooses where the chips seat and how large they can be there, then seats
 * them. `radii` are the chips at full size; the returned `scale` is the factor
 * that makes them fit, and the homes are already planned at that scale.
 *
 * Fitting from the measured geometry rather than from a viewport breakpoint is
 * what lets one hero serve a phone and a widescreen: the side gutters win while
 * they can hold a chip at near full size, and past that the field moves into the
 * bands above and below the content and shrinks to whatever depth they have.
 */
export function planField(
  radii: readonly number[],
  bounds: StepOptions["bounds"],
  exclusions: readonly ExclusionRect[],
): { scale: number; layout: FieldLayout; homes: { x: number; y: number }[] } {
  const seat = (scale: number, layout: FieldLayout) => ({
    scale,
    layout,
    homes: planHomes(
      radii.map((radius) => radius * scale),
      bounds,
      exclusions,
      layout,
    ),
  });
  if (radii.length === 0 || exclusions.length === 0) return seat(1, "side");

  const widest = Math.max(...radii);
  const left = Math.min(...exclusions.map((rect) => rect.centerX - rect.halfX));
  const right = Math.max(...exclusions.map((rect) => rect.centerX + rect.halfX));
  const top = Math.max(...exclusions.map((rect) => rect.centerY + rect.halfY));
  // Depth one full-size chip needs across a lane: its diameter plus its margin.
  const depth = 2 * widest + margin(widest);
  const [laneA, laneB] = splitLanes(radii);
  const longest = Math.max(laneLength(laneA), laneLength(laneB));

  // Side lanes: limited by the narrower gutter, and by the lane's own length
  // against the full height.
  const sideScale = Math.min(
    1,
    Math.min(bounds.x - right, left + bounds.x) / depth,
    (2 * bounds.y) / longest,
  );
  if (sideScale >= SIDE_MIN_SCALE) return seat(sideScale, "side");

  // Band: one arc over the content, so it is limited by the room above it and
  // by each half's lane length against half the width. Nothing is seated below
  // the content — under the screenshot is both off the fold and unreachable.
  const bandScale = Math.min(1, (bounds.y - top) / depth, bounds.x / longest);
  return seat(Math.max(MIN_SCALE, bandScale), "band");
}

/**
 * Resolves one elastic collision between two chips. A held chip acts as
 * infinite mass — it shoves its neighbours aside and never moves itself, which
 * is what makes dragging a chip through the field read as solid.
 */
function collide(a: ChipBody, b: ChipBody): void {
  // A chip still waiting on its entrance is parked off-screen and inert.
  if (a.delay > 0 || b.delay > 0) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 0.0001;
  const overlap = a.r + b.r - distance;
  if (overlap <= 0) return;

  const nx = dx / distance;
  const ny = dy / distance;
  // Share of the positional correction each body absorbs.
  const aShare = a.held ? 0 : b.held ? 1 : 0.5;
  const bShare = 1 - aShare;
  a.x -= nx * overlap * aShare;
  a.y -= ny * overlap * aShare;
  b.x += nx * overlap * bShare;
  b.y += ny * overlap * bShare;

  const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relative > 0) return;
  const impulse = -(1 + RESTITUTION) * relative * 0.5;
  // A hard enough knock sends the struck chip adrift as well, so a thrown chip
  // rearranges the ones it hits rather than briefly disturbing them.
  const knocked = Math.abs(relative) > THROW_SPEED && (a.adrift || b.adrift || a.held || b.held);
  if (!a.held) {
    a.vx -= impulse * nx * (b.held ? 2 : 1);
    a.vy -= impulse * ny * (b.held ? 2 : 1);
    // A struck chip goes free too, so a thrown chip scatters the ones it hits.
    a.free = Math.max(a.free, Math.min(1, Math.abs(relative) / 6));
    a.adrift = a.adrift || knocked;
  }
  if (!b.held) {
    b.vx += impulse * nx * (a.held ? 2 : 1);
    b.vy += impulse * ny * (a.held ? 2 : 1);
    b.free = Math.max(b.free, Math.min(1, Math.abs(relative) / 6));
    b.adrift = b.adrift || knocked;
  }

  const shear = impulse * SPIN_TRANSFER;
  a.spin -= shear;
  b.spin += shear;
}

/**
 * Releases a dragged chip, converting its carry velocity into a throw. Speeds
 * above `THROW_SPEED` also mark the chip free, so it flies instead of being
 * yanked straight back to its slot.
 */
export function releaseChip(body: ChipBody, vx: number, vy: number): void {
  body.held = false;
  body.vx = vx;
  body.vy = vy;
  clampSpeed(body);
  const speed = Math.hypot(vx, vy);
  if (speed > THROW_SPEED) {
    body.free = 1;
    body.adrift = true;
    body.spin += (vx * 0.35 + vy * 0.15) * -0.5;
    return;
  }
  // Set down rather than thrown: it still keeps the spot it was placed on, but
  // the solver does the re-anchoring so the shared cursor drift is discounted.
  body.free = 0;
  body.adrift = true;
}

/** Advances every chip by one solver substep. */
function solve(bodies: ChipBody[], step: number, options: StepOptions): void {
  for (const body of bodies) {
    // Staggered entrance: a delayed chip is not simulated at all, so it hangs
    // exactly where the scene parked it until its turn to drop.
    if (body.delay > 0) {
      body.delay -= step;
      continue;
    }

    if (!body.held) {
      body.free = Math.max(0, body.free - FREE_DECAY * step);
      body.bounce = Math.max(0, body.bounce - BOUNCE_DECAY * step);

      // An adrift chip carries its home along with it, so the spring never hauls
      // it back to the slot it was knocked out of. Once it parks, that spot
      // becomes its home for good and the spring holds it there like any other.
      if (body.adrift) {
        if (body.free <= 0 && Math.hypot(body.vx, body.vy) < PARK_SPEED) {
          body.adrift = false;
        }
        // Home is stored without the shared drift, so the chip does not shift
        // when the cursor lean eases back to zero.
        body.homeX = body.x - options.drift.x;
        body.homeY = body.y - options.drift.y;
      }

      // The whole field shares one drift, so the chips move together with the
      // cursor rather than each buzzing against its own proximity force.
      const targetX = body.homeX + options.drift.x;
      const targetY = body.homeY + options.drift.y;
      body.vx += (targetX - body.x) * HOME_SPRING * (1 - body.free) * step;
      body.vy += (targetY - body.y) * HOME_SPRING * (1 - body.free) * step;

      const retained = mix(SETTLED_DAMPING, FREE_DAMPING, Math.max(body.free, body.bounce));
      const decay = retained ** step;
      body.vx *= decay;
      body.vy *= decay;
      clampSpeed(body);

      body.x += body.vx * step;
      body.y += body.vy * step;
    }

    constrain(body, options);

    body.spin += -body.angle * UPRIGHT_SPRING * step;
    body.spin *= SPIN_DAMPING ** step;
    body.spin = clamp(body.spin, -MAX_SPIN, MAX_SPIN);
    body.angle += body.spin * step;
    // A chip in flight may tumble; one landing on its slot may only lean. The
    // limit tightens as the thrown state decays, so a tossed chip straightens
    // out on its way home instead of parking at whatever angle it stopped at.
    const tilt = mix(MAX_TILT, THROWN_TILT, body.held ? 1 : body.free);
    if (Math.abs(body.angle) > tilt) {
      body.angle = Math.sign(body.angle) * tilt;
      body.spin = 0;
    }
    body.tumble += step * 0.05;
  }

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i];
      const b = bodies[j];
      if (!a || !b) continue;
      collide(a, b);
    }
  }

  // Collisions can shove a chip back into a protected rectangle, so the walls
  // and exclusions have the last word every substep.
  for (const body of bodies) {
    constrain(body, options);
  }
}

/**
 * Advances every chip by `dt` seconds. Mutates the bodies in place — the scene
 * owns one stable array and copies nothing per frame.
 *
 * The frame is split into substeps short enough that no chip travels more than
 * `SWEEP_STEP` in one of them. The sweep in `constrain` is what makes a fast
 * toss legal at all; sub-stepping keeps each swept segment short, so a chip that
 * bounces off the screenshot in the middle of a frame gets the *rest* of that
 * frame to travel along its new heading instead of resuming next frame.
 */
export function stepChips(bodies: ChipBody[], dt: number, options: StepOptions): void {
  const frame = Math.min(dt, 1 / 30);
  let fastest = 0;
  for (const body of bodies) {
    if (body.delay > 0) continue;
    // A held chip is teleported by the drag, so its span is measured, not derived
    // from velocity.
    const reach = body.held
      ? Math.hypot(body.x - body.prevX, body.y - body.prevY) / frame
      : Math.hypot(body.vx, body.vy);
    fastest = Math.max(fastest, reach);
  }

  const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((fastest * frame) / SWEEP_STEP)));
  const step = frame / substeps;
  for (let index = 0; index < substeps; index += 1) {
    solve(bodies, step, options);
  }
}
