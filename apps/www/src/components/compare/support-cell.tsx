import { Check, Circle, Minus } from "lucide-react";

import type { Support } from "@/lib/compare-data";

/** Icon + size for each support level; text values (e.g. a license name) render as-is. */
const ICONS = {
  yes: { Icon: Check, size: "size-4" },
  partial: { Icon: Circle, size: "size-3" },
  no: { Icon: Minus, size: "size-4" },
} as const;

const TONE = {
  yes: "text-muted-foreground",
  partial: "text-muted-foreground",
  no: "text-muted-foreground/40",
} as const;

const LABEL = {
  yes: "Yes",
  partial: "Partial",
  no: "No",
} as const;

/**
 * One matrix cell: an icon for a support level, or the value itself where the
 * answer is a name rather than a yes or no. Shared by the landing page's
 * `Comparison` table and every `/compare/[slug]` detail table.
 */
export function SupportCell({ value, highlight }: { value: Support; highlight?: boolean }) {
  const key = value as keyof typeof ICONS;
  const mark = ICONS[key];
  if (!mark) return <span className="text-xs">{value}</span>;

  // Accent blue marks the Pragma column's own support: a selection signal, which
  // is the one job `DESIGN.md` gives it.
  const tone = value === "yes" && highlight ? "text-brand" : TONE[key];
  return (
    <span className={tone}>
      <mark.Icon className={`mx-auto ${mark.size}`} />
      <span className="sr-only">{LABEL[key]}</span>
    </span>
  );
}
