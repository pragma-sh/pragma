"use client";

import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FullSearchTrigger, SearchTrigger } from "fumadocs-ui/layouts/shared/slots/search-trigger";
import { Download, PanelLeft } from "lucide-react";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";

import { BrandFavicon } from "@/components/brand-favicon";
import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { appName, docsRoute, downloadUrl, pluginsRoute, repoUrl } from "@/lib/shared";
import { cn } from "@/lib/utils";

const navLinks = [
  { label: "Plugins", href: pluginsRoute },
  { label: "Docs", href: docsRoute },
];

interface SiteNavbarProps extends ComponentProps<"header"> {
  docsSidebarTrigger?: ReactNode;
  docs?: boolean;
}

/** Shared centered floating navigation for marketing and docs pages. */
export function SiteNavbar({
  className,
  docs = false,
  docsSidebarTrigger,
  ...props
}: SiteNavbarProps) {
  const pathname = usePathname();

  return (
    <header
      {...props}
      className={cn(
        "pointer-events-none z-50 mx-auto h-14 w-[calc(100%-1.5rem)] max-w-5xl",
        docs ? "fixed inset-x-0 top-3" : "sticky top-3 mt-3",
        className,
      )}
    >
      <nav
        aria-label="Primary navigation"
        className="border-border bg-card shadow-floating pointer-events-auto flex h-full items-center gap-1.5 rounded-full border px-1.5 sm:gap-2 sm:px-2"
      >
        <Link
          href="/"
          aria-label={`${appName} home`}
          className="focus-visible:ring-ring flex h-11 shrink-0 items-center gap-2 rounded-full px-2 outline-none focus-visible:ring-2"
        >
          <BrandFavicon className="size-7" />
          <span className="font-heading font-semibold max-[420px]:hidden">{appName}</span>
        </Link>

        <div className="hidden items-center sm:flex">
          {navLinks.map(({ label, href }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className="text-muted-foreground hover:text-foreground data-[active=true]:text-foreground focus-visible:ring-ring rounded-full px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2"
                data-active={active}
              >
                {label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <FullSearchTrigger
            hideIfDisabled
            className="bg-secondary/50 hidden h-11 w-40 rounded-full border-0 lg:inline-flex"
          />
          <SearchTrigger hideIfDisabled className="size-11 rounded-full p-0 lg:hidden" />

          <Button asChild variant="secondary" className="pill-cta gap-2 max-md:size-11 max-md:p-0">
            <a href={repoUrl} target="_blank" rel="noreferrer" aria-label="Pragma on GitHub">
              <GithubMark className="size-4" />
              <span className="max-md:hidden">GitHub</span>
            </a>
          </Button>

          <Button asChild className="pill-cta gap-2 max-sm:size-11 max-sm:p-0">
            <a href={downloadUrl} aria-label="Download Pragma">
              <Download className="size-4" />
              <span className="max-sm:hidden">Download</span>
            </a>
          </Button>

          {docsSidebarTrigger}
        </div>
      </nav>
    </header>
  );
}

/** Docs navbar adds Fumadocs mobile sidebar control while retaining shared chrome. */
export function DocsSiteNavbar(props: ComponentProps<"header">) {
  const { slots } = useDocsLayout();
  const SidebarTrigger = slots.sidebar.trigger;

  return (
    <SiteNavbar
      {...props}
      docs
      docsSidebarTrigger={
        <SidebarTrigger
          aria-label="Toggle documentation sidebar"
          className="hover:bg-accent focus-visible:ring-ring flex size-11 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 md:hidden"
        >
          <PanelLeft className="size-4" />
        </SidebarTrigger>
      }
    />
  );
}
