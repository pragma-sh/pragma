import { HomeLayout } from "fumadocs-ui/layouts/home";

import { SiteNavbar } from "@/components/site-navbar";
import { baseOptions } from "@/lib/layout.shared";

/**
 * The marketing surface is the artboard from `DESIGN.md` — `artboard` supplies
 * the brand values (light by default, `.dark .artboard` overriding under the
 * `dark` class next-themes toggles on `<html>`), `font-body` swaps Geist for
 * Inter Variable. Wrapping `HomeLayout` rather than the page puts the nav
 * inside the palette too. The toggle itself lives in `SiteNavbar`, shared with
 * `/docs`.
 */
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <div className="artboard bg-background text-foreground font-body flex flex-1 flex-col">
      <HomeLayout {...baseOptions()} slots={{ header: SiteNavbar }}>
        {children}
      </HomeLayout>
    </div>
  );
}
