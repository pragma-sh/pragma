import type { CSSProperties } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { DocsSiteNavbar } from "@/components/site-navbar";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const containerStyle = { "--fd-banner-height": "4.25rem" } as CSSProperties;

/**
 * Sniffs the platform into `data-platform` on <html> before the page paints, so
 * the CSS for `<Keys>` (`src/components/keys.tsx`) can hide the shortcut variant
 * that does not apply. With JS disabled the attribute is absent and CSS shows
 * both variants.
 */
const PLATFORM_SNIFF =
  'try{document.documentElement.dataset.platform=/Mac|iP(hone|ad|od)/.test(navigator.userAgent)?"mac":"other"}catch(e){}';

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PLATFORM_SNIFF }} />
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions()}
        slots={{ header: DocsSiteNavbar }}
        containerProps={{ className: "pt-[4.25rem]", style: containerStyle }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
