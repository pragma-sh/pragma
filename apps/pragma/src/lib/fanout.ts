// The fanout view model is shared with Pragma Go; only the comparison grid's
// column model is desktop-specific.
export * from "@pragma-sh/fanout-view";

/** Lower bound on a comparison column, in pixels. */
export const MIN_COLUMN_WIDTH = 320;

/**
 * Applies a header-separator drag to the shared column model.
 *
 * One model drives the sticky header and every section row: independent
 * resizable groups per row drift apart the moment a row is collapsed.
 */
export function resizeColumn(widths: readonly number[], index: number, deltaPx: number): number[] {
  return widths.map((width, position) =>
    position === index ? Math.max(MIN_COLUMN_WIDTH, width + deltaPx) : width,
  );
}
