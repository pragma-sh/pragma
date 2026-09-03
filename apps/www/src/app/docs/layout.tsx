import type { CSSProperties } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { DocsSiteNavbar } from "@/components/site-navbar";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

const containerStyle = { "--fd-banner-height": "4.25rem" } as CSSProperties;

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      slots={{ header: DocsSiteNavbar }}
      containerProps={{ className: "pt-[4.25rem]", style: containerStyle }}
    >
      {children}
    </DocsLayout>
  );
}
