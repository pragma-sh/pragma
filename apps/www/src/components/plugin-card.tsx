import Link from "next/link";
import type { LockedPlugin } from "@pragma/plugin-registry";

import { Button } from "@/components/ui/button";
import { pluginDetailUrl, pluginInstallUrl } from "@/lib/plugins";

/**
 * One grid cell of the official gallery — a preview of the plugin detail page.
 * The title carries a stretched link (`after:absolute after:inset-0`), so the
 * whole card opens the detail route while the install anchor keeps its own
 * target; nothing nests an anchor inside an anchor.
 */
export function PluginCard({ plugin }: { plugin: LockedPlugin }) {
  const { manifest } = plugin;
  const image = manifest.images?.[0];
  const command = [manifest.install.command, ...(manifest.install.args ?? [])].join(" ");

  return (
    <article className="group relative flex min-h-72 flex-col bg-card/40 p-6 transition-colors hover:bg-card/70">
      <div className="flex items-start justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          {image ? (
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-background p-2">
              {/* URLs are reviewed and cached in official lock metadata. */}
              <img className="max-h-full max-w-full" alt={image.alt} src={image.url} />
            </div>
          ) : null}
          <div className="min-w-0 text-left">
            <h2 className="truncate text-lg font-medium tracking-tight">
              <Link
                className="underline-offset-4 after:absolute after:inset-0 group-hover:underline focus-visible:underline focus-visible:outline-none"
                href={pluginDetailUrl(plugin.package)}
              >
                {manifest.name}
              </Link>
            </h2>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {plugin.package}
            </p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {plugin.version}
        </span>
      </div>

      <p className="mt-6 flex-1 text-left text-sm leading-6 text-muted-foreground">
        {manifest.description}
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {manifest.categories?.map((category) => (
          <span
            className="border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            key={category}
          >
            {category}
          </span>
        ))}
      </div>

      <div className="mt-4 overflow-hidden border border-border/70 bg-background/70 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
        <span className="mr-2 text-foreground/40">$</span>
        <span className="break-all">{command}</span>
      </div>

      <Button asChild className="pill-cta relative z-10 mt-4 w-full">
        <a href={pluginInstallUrl(plugin.package)}>Install in Pragma</a>
      </Button>
    </article>
  );
}
