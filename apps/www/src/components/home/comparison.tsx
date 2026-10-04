import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SupportCell } from "@/components/compare/support-cell";
import { FOOTNOTE, ROWS } from "@/lib/compare-data";
import { compareRoute } from "@/lib/shared";
import { Reveal, SectionHeading, SectionShell } from "./section";

/**
 * How Pragma compares to Emdash, Orca, and Superset.
 *
 * The rows sit on canvas (`{components.comparison-row}`) inside one charcoal
 * frame; the Pragma column is marked by a faint white wash and accent-blue
 * checkmarks — the blue is a selection signal here, which is the one job
 * `DESIGN.md` gives it, never a fill. `ROWS` and `SupportCell` are shared with
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
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[38%] min-w-64">Capability</TableHead>
                  <TableHead className="text-foreground text-center font-medium">Pragma</TableHead>
                  <TableHead className="text-center">Emdash</TableHead>
                  <TableHead className="text-center">Orca</TableHead>
                  <TableHead className="text-center">Superset</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ROWS.map((row) => (
                  <TableRow key={row.feature}>
                    <TableCell className="align-top">
                      <span className="text-foreground font-medium">{row.feature}</span>
                      <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                        {row.detail}
                      </span>
                    </TableCell>
                    <TableCell className="bg-foreground/[0.04] text-center align-middle">
                      <SupportCell value={row.pragma} highlight />
                    </TableCell>
                    <TableCell className="text-center align-middle">
                      <SupportCell value={row.emdash} />
                    </TableCell>
                    <TableCell className="text-center align-middle">
                      <SupportCell value={row.orca} />
                    </TableCell>
                    <TableCell className="text-center align-middle">
                      <SupportCell value={row.superset} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
