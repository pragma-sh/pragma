import { cn } from "@/lib/utils";

/**
 * Quiet octicon-field atmosphere for the GitHub section.
 *
 * Six glyphs — pull requests open, merged, and closed, issues open and closed,
 * and the GitHub mark — each drawn once, in `currentColor` only. Like
 * `FanoutGraph` it stays monotone by construction, so the wrapper's text color
 * is the only colour in it and the section keeps `DESIGN.md`'s "geometry, not a
 * second gradient" rule for section backgrounds.
 */

/** Canvas the field is laid out in; the SVG scales to its container. */
const WIDTH = 1200;
const HEIGHT = 600;
/** Glyph paths are authored on a 16x16 octicon grid. */
const GLYPH_GRID = 16;

/**
 * Octicon outlines (16x16), traced as strokes rather than the filled originals
 * so the field reads as line art at low opacity.
 */
interface Glyph {
  id: string;
  /** Stroked sub-paths. */
  strokes: readonly string[];
  /** Filled sub-paths — dots, and the GitHub mark. */
  fills?: readonly string[];
  /** Circles drawn as stroked outlines: [cx, cy, r]. */
  circles?: readonly (readonly [number, number, number])[];
}

const PR_OPEN: Glyph = {
  id: "pr-open",
  strokes: ["M4 5.5v7", "M12 8.5v4", "M12 5.5V3.2H9.4M12 5.5 10 3.6M12 5.5 10 7.4"],
  circles: [
    [4, 3.5, 1.6],
    [4, 13.5, 1.6],
    [12, 13.5, 1.6],
  ],
};

const PR_MERGED: Glyph = {
  id: "pr-merged",
  strokes: ["M4 5.5v6.4", "M12 5.5c0 3-2.6 4.3-5.2 4.5H4.4"],
  circles: [
    [4, 3.5, 1.6],
    [4, 13.5, 1.6],
    [12, 3.5, 1.6],
  ],
};

const PR_CLOSED: Glyph = {
  id: "pr-closed",
  strokes: ["M4 5.5v7", "M12 5.5v6", "M10.2 2.4l3.6 3.6M13.8 2.4l-3.6 3.6"],
  circles: [
    [4, 3.5, 1.6],
    [4, 13.5, 1.6],
    [12, 13.5, 1.6],
  ],
};

const ISSUE_OPEN: Glyph = {
  id: "issue-open",
  strokes: [],
  circles: [
    [8, 8, 6.3],
    [8, 8, 1.8],
  ],
};

const ISSUE_CLOSED: Glyph = {
  id: "issue-closed",
  strokes: ["M5.2 8.1l2.1 2.1 3.6-4.2"],
  circles: [[8, 8, 6.3]],
};

const GITHUB_MARK: Glyph = {
  id: "github-mark",
  strokes: [],
  fills: [
    "M8 .8a7.2 7.2 0 0 0-2.28 14.04c.36.06.49-.16.49-.35v-1.24c-2 .44-2.43-.96-2.43-.96-.33-.83-.8-1.06-.8-1.06-.66-.45.05-.44.05-.44.73.05 1.11.75 1.11.75.65 1.11 1.7.79 2.12.6.06-.47.25-.79.46-.97-1.6-.18-3.28-.8-3.28-3.56 0-.79.28-1.43.74-1.93-.07-.18-.32-.91.07-1.9 0 0 .6-.19 1.98.74a6.9 6.9 0 0 1 3.6 0c1.37-.93 1.97-.74 1.97-.74.4.99.15 1.72.07 1.9.47.5.74 1.14.74 1.93 0 2.77-1.68 3.38-3.29 3.55.26.22.49.66.49 1.33v1.97c0 .19.13.42.5.35A7.2 7.2 0 0 0 8 .8Z",
  ],
};

interface Mark {
  glyph: Glyph;
  /** Centre, in canvas units. */
  x: number;
  y: number;
  /** Edge length of the glyph box inside the chip. */
  size: number;
  rotation: number;
}

/**
 * Every glyph appears exactly once, seated in a small chip and placed by hand
 * around the section's outer band. Positions are literal rather than generated:
 * a repeated mark reads as wallpaper, and the six states are the point — open,
 * merged, and closed pull requests, open and closed issues, and the mark itself.
 *
 * The chip is what keeps the field quiet. A bare glyph at this size either
 * disappears or shouts; sitting on a faint rounded surface it reads as a small
 * object resting on the canvas, the same way the section's cards do.
 */
const MARKS: readonly Mark[] = [
  { glyph: PR_OPEN, x: 108, y: 116, size: 30, rotation: -8 },
  { glyph: ISSUE_OPEN, x: 356, y: 58, size: 24, rotation: 0 },
  { glyph: GITHUB_MARK, x: 142, y: 456, size: 34, rotation: 6 },
  { glyph: PR_MERGED, x: 452, y: 492, size: 27, rotation: 9 },
  { glyph: ISSUE_CLOSED, x: 906, y: 92, size: 25, rotation: -6 },
  { glyph: PR_CLOSED, x: 1096, y: 452, size: 29, rotation: 7 },
];

/** Chip edge, as a multiple of the glyph box it holds. */
const CHIP_PADDING = 1.75;
/** Chip corner radius, as a share of its edge. */
const CHIP_RADIUS = 0.26;

export function GitHubMarks({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("text-muted-foreground h-full w-full", className)}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      {MARKS.map((mark) => {
        const scale = mark.size / GLYPH_GRID;
        const offset = -GLYPH_GRID / 2;
        const chip = mark.size * CHIP_PADDING;
        return (
          <g
            key={`${mark.glyph.id}-${mark.x}-${mark.y}`}
            transform={`translate(${mark.x} ${mark.y}) rotate(${mark.rotation})`}
          >
            <rect
              x={-chip / 2}
              y={-chip / 2}
              width={chip}
              height={chip}
              rx={chip * CHIP_RADIUS}
              fill="currentColor"
              fillOpacity={0.05}
              stroke="currentColor"
              strokeOpacity={0.14}
              strokeWidth={1}
            />
            <g opacity={0.4} transform={`scale(${scale}) translate(${offset} ${offset})`}>
              <g
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              >
                {mark.glyph.strokes.map((d) => (
                  <path key={d} d={d} />
                ))}
                {mark.glyph.circles?.map(([cx, cy, r]) => (
                  <circle key={`${cx}-${cy}-${r}`} cx={cx} cy={cy} r={r} />
                ))}
              </g>
              {mark.glyph.fills?.map((d) => (
                <path key={d} d={d} fill="currentColor" />
              ))}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
