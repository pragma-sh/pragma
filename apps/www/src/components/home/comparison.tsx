import { Check, Circle, Minus } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Reveal, SectionHeading, SectionShell } from "./section";

type Support = "yes" | "partial" | "no" | string;

interface ComparisonRow {
  feature: string;
  detail: string;
  pragma: Support;
  emdash: Support;
  orca: Support;
  superset: Support;
}

/**
 * Feature matrix against the other open agent orchestrators. Cells were checked
 * against each project's own repository (not only its marketing pages) — see the
 * footnote for the review date.
 */
const ROWS: readonly ComparisonRow[] = [
  {
    feature: "Native shell",
    detail: "Rust host + the OS webview, not a bundled browser",
    pragma: "Tauri + Rust",
    emdash: "Electron",
    orca: "Electron",
    superset: "Electron",
  },
  {
    feature: "Agents as plugins",
    detail: "Each integration is its own versioned package with official branding",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Public plugin API",
    detail: "Third-party sidebar tabs, cards, web views, and commands in the app itself",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "no",
  },
  {
    feature: "Programmable automations",
    detail: "Your own TypeScript running on host events, not just a schedule",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Interactive agent scratchpads",
    detail: "Agents write MDX with live React components you can edit and comment on",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "no",
  },
  {
    feature: "Agent board",
    detail: "Prompt to review to pull request as tracked cards",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "yes",
  },
  {
    feature: "Fan out + comparison view",
    detail: "One prompt into N attempts, compared as terminals, diffs, and scratchpads",
    pragma: "yes",
    emdash: "no",
    orca: "yes",
    superset: "partial",
  },
  {
    feature: "Editing suite",
    detail: "Code editor, markdown WYSIWYG, PDF, image, video, and audio viewers",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Built-in AI, your key",
    detail: "Inline ⌘K edits, one-click PR drafting, ask-anything from the palette",
    pragma: "yes",
    emdash: "no",
    orca: "partial",
    superset: "no",
  },
  {
    feature: "Mobile & web client",
    detail: "Platforms it ships, and how you reach it off your LAN",
    pragma: "iOS, Android, Web — own tunnel",
    emdash: "no",
    orca: "iOS, Android — needs Tailscale/VPS",
    superset: "iOS only, Pro-only — hosted relay",
  },
  {
    feature: "Persistent host server",
    detail: "Sessions, tunnels, and headless launches survive quitting the app",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Remote projects",
    detail: "SSH hosts as first-class remote projects",
    pragma: "SSH",
    emdash: "SSH",
    orca: "SSH + WSL",
    superset: "no",
  },
  {
    feature: "User themes",
    detail: "Editable colour tokens per project, not a fixed preset list",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "License",
    detail: "What you are allowed to do with the source",
    pragma: "AGPL-3.0",
    emdash: "Apache-2.0",
    orca: "MIT",
    superset: "Elastic 2.0",
  },
];

function SupportCell({ value, highlight }: { value: Support; highlight?: boolean }) {
  if (value === "yes") {
    return (
      <span className={highlight ? "text-brand" : "text-muted-foreground"}>
        <Check className="mx-auto size-4" />
        <span className="sr-only">Yes</span>
      </span>
    );
  }
  if (value === "partial") {
    return (
      <span className="text-muted-foreground">
        <Circle className="mx-auto size-3" />
        <span className="sr-only">Partial</span>
      </span>
    );
  }
  if (value === "no") {
    return (
      <span className="text-muted-foreground/40">
        <Minus className="mx-auto size-4" />
        <span className="sr-only">No</span>
      </span>
    );
  }
  return <span className="text-xs">{value}</span>;
}

/**
 * How Pragma compares to Emdash, Orca, and Superset.
 *
 * The rows sit on canvas (`{components.comparison-row}`) inside one charcoal
 * frame; the Pragma column is marked by a faint white wash and accent-blue
 * checkmarks — the blue is a selection signal here, which is the one job
 * `DESIGN.md` gives it, never a fill.
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
            Checked against the <code>generalaction/emdash</code>, <code>stablyai/orca</code>, and{" "}
            <code>superset-sh/superset</code> repositories as of 2026-08-29. These projects ship
            fast — if something here is out of date, open an issue and we will correct it. On the
            mobile row: Pragma's tunnel is a command you supply and control (ngrok, cloudflared, a
            Tailscale funnel — whatever you already run), not a vendor relay you depend on. Orca has
            no tunnel of its own — remote access means installing Tailscale yourself or running
            Orca's full server on a VPS. Superset's reaches your machine through Superset's own
            hosted relay, and the iOS app is Pro-plan only.
          </p>
        </Reveal>
      </div>
    </SectionShell>
  );
}
