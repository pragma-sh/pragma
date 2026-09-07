import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";

import { BrandIcon } from "@/components/brand-icon";
import { SupportCell } from "@/components/compare/support-cell";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { COMPETITORS, FOOTNOTE, getCompetitor, ROWS } from "@/lib/compare-data";
import { appName, compareRoute, downloadUrl } from "@/lib/shared";

/** Pre-renders one `/compare/[slug]` route per competitor at build time. */
export function generateStaticParams() {
  return COMPETITORS.map((competitor) => ({ slug: competitor.slug }));
}

/** Builds the page title/description for a competitor's comparison page. */
export async function generateMetadata(props: PageProps<"/compare/[slug]">): Promise<Metadata> {
  const params = await props.params;
  const competitor = getCompetitor(params.slug);
  if (!competitor) notFound();
  return {
    // The root layout template appends "— Pragma".
    title: `${appName} vs ${competitor.name}`,
    description: `How ${appName} compares to ${competitor.name} — ${competitor.tagline} — feature by feature, checked against ${competitor.repo} on GitHub, plus how to migrate.`,
  };
}

/** Detail page comparing Pragma to one competitor, feature by feature. */
export default async function CompareDetailPage(props: PageProps<"/compare/[slug]">) {
  const params = await props.params;
  const competitor = getCompetitor(params.slug);
  if (!competitor) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pt-16 pb-16 text-center sm:pt-24 sm:pb-24">
        <Link
          href={compareRoute}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← All comparisons
        </Link>

        <div className="mt-10 flex items-center gap-5 sm:gap-8">
          <div className="border-border bg-card flex size-20 shrink-0 items-center justify-center rounded-2xl border p-3.5 sm:size-24">
            <BrandIcon className="size-full" />
          </div>
          <span className="text-muted-foreground font-heading text-sm tracking-wide uppercase">
            vs
          </span>
          <div className="border-border bg-background flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border p-3 sm:size-24">
            <Image
              src={competitor.logo}
              alt={`${competitor.name} logo`}
              width={80}
              height={80}
              className="size-full object-contain"
            />
          </div>
        </div>

        <h1 className="font-heading type-display-lg mt-8 text-balance">
          {appName} vs {competitor.name}
        </h1>
        <p className="text-muted-foreground mt-3 max-w-md text-sm">{competitor.tagline}</p>
        <p className="text-muted-foreground/70 mt-2 text-xs">
          {competitor.license} · {appName} is AGPL-3.0
        </p>

        <Button asChild className="pill-cta mt-8 gap-2">
          <a href={downloadUrl}>
            <Download className="size-4" />
            Download {appName}
          </a>
        </Button>
      </header>

      <section className="mx-auto w-full max-w-2xl space-y-4 px-6 pb-16 text-sm leading-relaxed sm:pb-20">
        {competitor.summary.map((paragraph) => (
          <p key={paragraph.slice(0, 40)} className="text-foreground/90">
            {paragraph}
          </p>
        ))}
      </section>

      <section className="border-border border-t px-6 py-16 sm:py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="font-heading type-display-md text-balance">
            {appName} vs {competitor.name}, capability by capability
          </h2>
          <div className="border-border bg-card mt-8 overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[46%] min-w-64">Capability</TableHead>
                  <TableHead className="text-foreground text-center font-medium">
                    {appName}
                  </TableHead>
                  <TableHead className="text-center">{competitor.name}</TableHead>
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
                      <SupportCell value={row[competitor.key]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground mt-4 text-xs">{FOOTNOTE}</p>
        </div>
      </section>

      <section className="border-border border-t px-6 py-16 sm:py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="font-heading type-display-md text-balance">
            Migrating from {competitor.name} to {appName}
          </h2>
          <p className="text-muted-foreground mt-4 max-w-2xl text-lg leading-[1.3]">
            No export step: {competitor.name} and {appName} both run agents in plain git worktrees,
            so you can add each existing branch as a Pragma worktree in a couple clicks — nothing to
            convert.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {competitor.migration.map((step) => (
              <div key={step.title} className="border-border border-l-2 pl-5">
                <h3 className="text-foreground font-medium">{step.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-border border-t px-6 py-20 sm:py-24">
        <div className="spotlight rounded-panel mx-auto max-w-5xl px-6 py-16 text-center sm:px-16 sm:py-20">
          <h2 className="font-heading type-display-md mx-auto max-w-2xl text-balance">
            Bring your {competitor.name} worktrees over — see what changes.
          </h2>
          <div className="mt-8 flex justify-center">
            <Button asChild className="pill-cta gap-2">
              <a href={downloadUrl}>
                <Download className="size-4" />
                Download {appName}
              </a>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
