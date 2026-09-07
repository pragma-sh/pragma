import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { BrandIcon } from "@/components/brand-icon";
import { Comparison } from "@/components/home/comparison";
import { appName } from "@/lib/shared";
import { compareDetailRoute, COMPETITORS } from "@/lib/compare-data";

export const metadata: Metadata = {
  title: "Pragma vs Competitors",
  description:
    "How Pragma compares to Emdash, Orca, and Superset — the other open agent orchestrators built around git worktrees — feature by feature, checked against each project's own repository.",
};

/** One competitor tile: both marks, the one-line take, and a stretched link to the detail page. */
function CompetitorCard({ competitor }: { competitor: (typeof COMPETITORS)[number] }) {
  return (
    <article className="group border-border bg-card/40 hover:bg-card/70 relative flex flex-col gap-5 rounded-xl border p-6 transition-colors">
      <div className="flex items-center gap-3">
        <div className="border-border bg-background flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border p-1.5">
          <Image
            src={competitor.logo}
            alt=""
            width={40}
            height={40}
            className="size-full object-contain"
          />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-medium tracking-tight">
            <Link
              href={compareDetailRoute(competitor.slug)}
              className="underline-offset-4 after:absolute after:inset-0 group-hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {appName} vs {competitor.name}
            </Link>
          </h2>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{competitor.license}</p>
        </div>
      </div>
      <p className="text-muted-foreground flex-1 text-sm leading-6">{competitor.tagline}</p>
      <span className="text-foreground relative z-10 inline-flex items-center gap-1.5 text-sm font-medium">
        Full comparison
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </article>
  );
}

export default function ComparePage() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 pt-16 pb-10 sm:pt-24">
        <p className="text-muted-foreground font-mono text-xs tracking-[0.2em] uppercase">
          {appName} vs Competitors
        </p>
        <h1 className="font-heading type-display-lg mt-4 max-w-3xl text-balance">
          Every agent orchestrator isolates worktrees. Here's what's different.
        </h1>
        <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-[1.3]">
          Emdash, Orca, and Superset all run coding agents in parallel git worktrees, the same
          starting point as {appName}. Each page below is checked against that project's own GitHub
          repository — README, license, and linked docs — not just its marketing site, and covers
          how to bring your existing worktrees over.
        </p>
      </header>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-6 pb-16 sm:grid-cols-3 sm:pb-24">
        {COMPETITORS.map((competitor) => (
          <CompetitorCard key={competitor.slug} competitor={competitor} />
        ))}
      </section>

      <Comparison />

      <section className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-24">
        <div className="border-border bg-card/40 flex flex-col items-start gap-6 rounded-xl border p-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <BrandIcon className="size-9 shrink-0" />
            <div>
              <h2 className="font-heading text-lg font-semibold">
                Already on Emdash, Orca, or Superset?
              </h2>
              <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
                All four tools use plain git worktrees, so there's nothing to export. Open your
                project in {appName} and your existing branches show up as-is — see each comparison
                page for the rest of the move.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
