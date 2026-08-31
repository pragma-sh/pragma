import Link from "next/link";

import { appName, docsRoute, gitConfig } from "@/lib/shared";

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Parallel work", href: "#parallel" },
      { label: "Agent board", href: "#board" },
      { label: "Fan out", href: "#fanout" },
      { label: "Pull requests", href: "#github" },
      { label: "Pragma Go", href: "#go" },
      { label: "Comparison", href: "#comparison" },
    ],
  },
  {
    title: "Build on it",
    links: [
      { label: "Plugin API", href: `${docsRoute}` },
      { label: "TypeScript SDK", href: `${repoUrl}/blob/main/SDK.md` },
      { label: "CLI", href: `${repoUrl}/blob/main/CLI.md` },
      { label: "Create a plugin", href: `${repoUrl}/blob/main/CREATE_PLUGIN.md` },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Documentation", href: docsRoute },
      { label: "GitHub", href: repoUrl },
      { label: "Issues", href: `${repoUrl}/issues` },
      { label: "License (AGPL-3.0)", href: `${repoUrl}/blob/main/LICENSE` },
    ],
  },
];

/** Site footer: closing statement plus the standard link columns. */
export function SiteFooter() {
  return (
    <footer className="border-border border-t px-6 py-16">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[2fr_3fr]">
        <div>
          <p className="font-heading type-display-md">{appName}</p>
          <p className="text-muted-foreground mt-4 max-w-sm text-sm leading-[1.4]">
            An agentic development environment for people who run more agents than they have
            attention. Local-first, open source, and yours to extend.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <p className="text-sm font-medium">{column.title}</p>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-border text-muted-foreground mx-auto mt-12 flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t pt-6 text-xs">
        <span>
          © {new Date().getFullYear()} {appName}. Built with agents, in public.
        </span>
        <span>macOS · Linux · Windows · iOS · Android · Web</span>
      </div>
    </footer>
  );
}
