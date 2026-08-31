import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/lib/layout.shared";

/**
 * The marketing surface is the artboard from `DESIGN.md`, and it is dark-only —
 * `dark` resolves the shadcn primitives' own `dark:` variants, `artboard`
 * supplies the brand values, and `font-body` swaps Geist for Inter Variable.
 * Wrapping `HomeLayout` rather than the page puts the nav inside the palette
 * too. `/docs` sits outside this file and keeps its light/dark toggle.
 */
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <div className="dark artboard bg-background text-foreground font-body flex flex-1 flex-col">
      {/*
        No theme switch on the marketing nav: the artboard is dark-only, so the
        control would be a no-op here. `/docs` still offers it.
      */}
      <HomeLayout {...baseOptions()} themeSwitch={{ enabled: false }}>
        {children}
      </HomeLayout>
    </div>
  );
}
