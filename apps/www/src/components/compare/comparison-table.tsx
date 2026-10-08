import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ComparisonColumn, Support } from "@/lib/compare-data";
import { SupportCell } from "./support-cell";

/** The fields every comparison row carries, whatever else it compares against. */
interface ComparedRow {
  feature: string;
  detail: string;
  pragma: Support;
}

/**
 * A capability matrix: Pragma's column first, marked by a faint wash and accent
 * checkmarks, then one column per product it is compared with. Shared by the
 * landing page, every `/compare/[slug]` page, and the Pragma Go page.
 */
export function ComparisonTable<Row extends ComparedRow>({
  rows,
  pragmaLabel,
  columns,
  capabilityClassName,
}: {
  rows: readonly Row[];
  pragmaLabel: string;
  columns: readonly ComparisonColumn<Row>[];
  /** Width of the capability column, which differs with the column count. */
  capabilityClassName: string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={capabilityClassName}>Capability</TableHead>
          <TableHead className="text-foreground text-center font-medium">{pragmaLabel}</TableHead>
          {columns.map((column) => (
            <TableHead key={column.label} className="text-center">
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
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
            {columns.map((column) => (
              <TableCell key={column.label} className="text-center align-middle">
                <SupportCell value={row[column.key] as Support} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
