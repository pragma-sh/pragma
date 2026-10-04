import {
  cushionStops,
  paletteColor,
  squarify,
  type CushionStop,
  type TreemapRect,
} from "@pragma-sh/treemap";

/**
 * The Storage treemap as a blog cover: the same squarified layout, palette,
 * and cushion shading the desktop Settings → Storage page draws, fed with an
 * illustrative set of projects instead of a real disk scan.
 */

/** Cover size: the blog's 1200:760 cover ratio, at 2x for high-density screens. */
export const STORAGE_COVER_SIZE = { width: 2400, height: 1520 } as const;

/** Black gutter inside each project's box, matching the desktop's at 2x. */
const PROJECT_GUTTER = 8;

/** Width of the line drawn around each project, inside its gutter. */
export const PROJECT_FRAME_WIDTH = 4;

interface Folder {
  gigabytes: number;
}

interface Worktree {
  folders: readonly Folder[];
}

interface Project {
  worktrees: readonly Worktree[];
}

/** Top-level folders of a worktree, in GB: build output dwarfs the source. */
const folders = (...sizes: number[]): Folder[] => sizes.map((gigabytes) => ({ gigabytes }));

/** Three projects shaped like a real week of parallel worktrees. */
const PROJECTS: readonly Project[] = [
  {
    worktrees: [
      { folders: folders(69, 6.2, 2.4, 1.1, 0.6, 0.3) },
      { folders: folders(21, 4.8, 1.9, 0.7, 0.4) },
      { folders: folders(12, 3.6, 1.2, 0.5) },
    ],
  },
  {
    worktrees: [{ folders: folders(9.4, 5.1, 1.6, 0.8) }, { folders: folders(7.2, 3.3, 1.1) }],
  },
  {
    worktrees: [{ folders: folders(6.1, 2.2, 0.9, 0.4) }, { folders: folders(3.8, 1.4, 0.6) }],
  },
];

/** One shaded box of the cover. */
export interface CoverTile extends TreemapRect {
  /** CSS angle that runs the gradient corner to corner, as the canvas does. */
  angle: number;
  stops: readonly CushionStop[];
}

/** Every tile and project frame of the cover, in pixels. */
export interface StorageCoverLayout {
  tiles: CoverTile[];
  frames: TreemapRect[];
}

const total = (sizes: readonly number[]) => sizes.reduce((sum, size) => sum + size, 0);
const worktreeBytes = (worktree: Worktree) => total(worktree.folders.map((f) => f.gigabytes));
const projectBytes = (project: Project) => total(project.worktrees.map(worktreeBytes));

/**
 * The CSS `linear-gradient` angle whose line runs from a box's top-left to its
 * bottom-right corner. Its length is then the diagonal, exactly the canvas
 * gradient the desktop draws from `(x, y)` to `(x + width, y + height)`.
 */
export function diagonalAngle(width: number, height: number): number {
  return (Math.atan2(width, -height) * 180) / Math.PI;
}

function inset(rect: TreemapRect, gap: number): TreemapRect {
  return {
    x: rect.x + gap,
    y: rect.y + gap,
    width: rect.width - gap * 2,
    height: rect.height - gap * 2,
  };
}

/**
 * Lays the cover out, coloring like the desktop's storage model: each project
 * starts three palette slots after the last, each worktree takes the next slot
 * in its project, and each folder the slot after its worktree's.
 */
export function layoutStorageCover(): StorageCoverLayout {
  const { width, height } = STORAGE_COVER_SIZE;
  const layout: StorageCoverLayout = { tiles: [], frames: [] };
  const projects = squarify(
    PROJECTS.map((project, index) => ({ value: projectBytes(project), data: { project, index } })),
    { x: 0, y: 0, width, height },
  );
  for (const projectTile of projects) {
    layout.frames.push(projectTile);
    const projectColor = projectTile.data.index * 3;
    const worktrees = squarify(
      projectTile.data.project.worktrees.map((worktree, member) => ({
        value: worktreeBytes(worktree),
        data: { worktree, color: projectColor + member },
      })),
      inset(projectTile, PROJECT_GUTTER),
    );
    for (const worktreeTile of worktrees) {
      const tiles = squarify(
        worktreeTile.data.worktree.folders.map((folder, index) => ({
          value: folder.gigabytes,
          data: worktreeTile.data.color + index + 1,
        })),
        worktreeTile,
      );
      for (const tile of tiles) {
        layout.tiles.push({
          x: tile.x,
          y: tile.y,
          width: tile.width,
          height: tile.height,
          angle: diagonalAngle(tile.width, tile.height),
          stops: cushionStops(paletteColor(tile.data)),
        });
      }
    }
  }
  return layout;
}
