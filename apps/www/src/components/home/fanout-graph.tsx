import { cn } from "@/lib/utils";

/**
 * Quiet branching-graph atmosphere for the fanout section.
 *
 * A sideways tree: one base commit on the left splitting into attempts that
 * split again, with a pulse travelling out along each rail. It is monotone by
 * construction — every stroke is `currentColor`, so the wrapper's text color is
 * the only colour in it and the section stays within `DESIGN.md`'s "geometry,
 * not a second gradient" rule for section backgrounds.
 *
 * The geometry is generated once at module load from a seeded generator rather
 * than at render, so the server and the client draw the identical tree and
 * nothing re-lays-out on hydration.
 */

/** Canvas the tree is laid out in; the SVG scales to its container. */
const WIDTH = 1200;
const HEIGHT = 600;
/** Depth of the tree, root included. */
const DEPTH = 4;
/** Horizontal room the deepest generation stops short of the right edge. */
const MARGIN_X = 70;
/** Vertical half-spread of the first split; each generation gets less. */
const SPREAD = 170;
/** Keeps the outermost heads clear of the top and bottom of the canvas. */
const MARGIN_Y = 60;

interface GraphNode {
  x: number;
  y: number;
  depth: number;
}

interface GraphEdge {
  d: string;
  depth: number;
  /** Fraction of the way down the tree's vertical extent, for pulse stagger. */
  offset: number;
}

/** Deterministic 32-bit generator, so the tree is stable across renders. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Horizontal position of a generation. */
function columnX(depth: number): number {
  return MARGIN_X + (depth / (DEPTH - 1)) * (WIDTH - MARGIN_X * 2);
}

function buildGraph(): { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] } {
  const random = makeRandom(0x9e37);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const root: GraphNode = { x: columnX(0), y: HEIGHT / 2, depth: 0 };
  nodes.push(root);

  let generation: GraphNode[] = [root];
  for (let depth = 1; depth < DEPTH; depth += 1) {
    const next: GraphNode[] = [];
    const spread = SPREAD / depth;
    const x = columnX(depth);
    for (const parent of generation) {
      // The root fans wide; deeper nodes mostly split in two, and some run on
      // alone so the tree reads as attempts that kept going rather than a grid.
      const children = depth === 1 ? 3 : random() < 0.25 ? 1 : 2;
      for (let index = 0; index < children; index += 1) {
        const centred = children === 1 ? 0 : (index / (children - 1)) * 2 - 1;
        const drift = parent.y + centred * spread + (random() - 0.5) * spread * 0.35;
        const y = Math.min(HEIGHT - MARGIN_Y, Math.max(MARGIN_Y, drift));
        const child: GraphNode = { x, y, depth };
        next.push(child);
        nodes.push(child);
        const dx = (x - parent.x) * 0.55;
        edges.push({
          d: `M${parent.x} ${parent.y} C${parent.x + dx} ${parent.y} ${x - dx} ${y} ${x} ${y}`,
          depth,
          offset: y / HEIGHT,
        });
      }
    }
    generation = next;
  }

  return { nodes, edges };
}

const { nodes, edges } = buildGraph();

/** Seconds one pulse takes to cross a single generation. */
const PULSE_SPAN = 1.4;
/**
 * Fraction of the cycle a pulse spends crossing one generation. It is fixed by
 * `fanout-pulse-travel` in `global.css`, so the cycle is derived from it rather
 * than chosen: a wave leaves the base commit, reaches the far heads, and the
 * remainder of the cycle is the gap before the next one.
 */
const PULSE_DUTY = 0.25;
const PULSE_CYCLE = PULSE_SPAN / PULSE_DUTY;

export function FanoutGraph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("text-muted-foreground h-full w-full", className)}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      <g stroke="currentColor" strokeLinecap="round">
        {edges.map((edge) => (
          <path key={edge.d} d={edge.d} strokeWidth={1.25} opacity={0.28} />
        ))}
        {edges.map((edge) => (
          <path
            key={`pulse-${edge.d}`}
            className="fanout-pulse"
            d={edge.d}
            pathLength={1}
            strokeWidth={2}
            strokeDasharray="0.16 0.84"
            style={{
              // One wave crosses the whole tree: a generation lights up only
              // once the one feeding it has finished, so the pulse arrives at
              // the far heads instead of every rail blinking at once. The
              // vertical offset is a fraction of a span, enough to keep sibling
              // rails out of lockstep without breaking the hand-off.
              animationDuration: `${PULSE_CYCLE}s`,
              animationDelay: `${(edge.depth - 1 + edge.offset * 0.12) * PULSE_SPAN}s`,
            }}
          />
        ))}
      </g>
      <g fill="currentColor">
        {nodes.map((node) => (
          <circle
            key={`${node.x}-${node.y}`}
            cx={node.x}
            cy={node.y}
            r={node.depth === 0 ? 6 : 3.5}
            opacity={node.depth === 0 ? 0.55 : 0.35}
          />
        ))}
      </g>
    </svg>
  );
}
