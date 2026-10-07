import Link from "next/link";

import { ComparisonTable } from "@/components/compare/comparison-table";
import { type ComparisonColumn, type ComparisonRow, FOOTNOTE, ROWS } from "@/lib/compare-data";
import { compareRoute } from "@/lib/shared";
import { Reveal, SectionHeading, SectionShell } from "./section";

const COLUMNS: readonly ComparisonColumn<ComparisonRow>[] = [
  { label: "Emdash", key: "emdash" },
  { label: "Orca", key: "orca" },
  { label: "Superset", key: "superset" },
];

/**
 * How Pragma compares to Emdash, Orca, and Superset.
 *
 * The rows sit on canvas (`{components.comparison-row}`) inside one charcoal
 * frame; the Pragma column is marked by a faint white wash and accent-blue
 * checkmarks — the blue is a selection signal here, which is the one job
 * `DESIGN.md` gives it, never a fill. `ROWS` and `ComparisonTable` are shared with
 * every `/compare/[slug]` page so a correction only has to happen once.
 */
export function Comparison() {
  return (
    <SectionShell id="comparison">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading
            align="center"
            title="The same worktrees, a much larger workspace"
            description="Everyone in this space isolates agents in git worktrees. Pragma is the one that treats the surrounding environment — plugins, automations, editors, boards, phones — as part of the product."
          />
        </Reveal>

        <Reveal delay={0.08} className="mt-12">
          <div className="border-border bg-card overflow-x-auto rounded-xl border">
            <ComparisonTable
              rows={ROWS}
              pragmaLabel="Pragma"
              columns={COLUMNS}
              capabilityClassName="w-[38%] min-w-64"
            />
          </div>
          <p className="text-muted-foreground mt-4 text-xs">
            {FOOTNOTE} Read a fuller, sourced write-up for each one on the{" "}
            <Link href={compareRoute} className="text-foreground underline underline-offset-2">
              comparison pages
            </Link>
            , including how to migrate.
          </p>
        </Reveal>
      </div>
    </SectionShell>
  );
}
