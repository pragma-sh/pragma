import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { loadOfficialPlugins, pluginInstallUrl, pluginNpmUrl } from "@/lib/plugins";
import { pluginsRoute } from "@/lib/shared";

type Plugin = Awaited<ReturnType<typeof loadOfficialPlugins>>[number];
type PluginImage = NonNullable<Plugin["manifest"]["images"]>[number];

/**
 * Resolves the `[...package]` segments back to the npm package identity. Next
 * delivers dynamic params URL-encoded (`%40pragma-sh/...`), so decode each
 * segment; a segment that is already plain decodes to itself.
 */
async function findPlugin(segments: string[] | undefined) {
  const plugins = await loadOfficialPlugins();
  const packageName = segments
    ?.map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
  return plugins.find((candidate) => candidate.package === packageName) ?? null;
}

export async function generateStaticParams() {
  const plugins = await loadOfficialPlugins();
  return plugins.map((plugin) => ({ package: plugin.package.split("/") }));
}

export async function generateMetadata(
  props: PageProps<"/plugins/[...package]">,
): Promise<Metadata> {
  const params = await props.params;
  const plugin = await findPlugin(params.package);
  if (!plugin) notFound();
  return {
    // The root layout template appends "— Pragma".
    title: plugin.manifest.name,
    description: plugin.manifest.description,
  };
}

function PluginHeader({ plugin, icon }: { plugin: Plugin; icon: PluginImage | undefined }) {
  return (
    <header className="mt-8 grid gap-10 border-b pb-10 md:grid-cols-[1fr_auto] md:items-end">
      <div className="flex items-center gap-5">
        {icon ? (
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-background p-3">
            {/* URLs are reviewed and cached in official lock metadata. */}
            <img className="max-h-full max-w-full" alt={icon.alt} src={icon.url} />
          </div>
        ) : null}
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-semibold tracking-tight sm:text-4xl">
            {plugin.manifest.name}
          </h1>
          <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
            {plugin.package} · v{plugin.version}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 md:justify-end">
        <Button asChild className="pill-cta">
          <a href={pluginInstallUrl(plugin.package)}>Install in Pragma</a>
        </Button>
        <Button asChild className="pill-cta" variant="secondary">
          <a href={pluginNpmUrl(plugin.package)} target="_blank" rel="noreferrer">
            View on npm
          </a>
        </Button>
      </div>
    </header>
  );
}

function PluginMetadata({ plugin, command }: { plugin: Plugin; command: string }) {
  const { manifest } = plugin;
  return (
    <aside className="space-y-6 self-start border-l pl-8">
      <div>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Package
        </h2>
        <p className="mt-2 break-all font-mono text-sm">{plugin.package}</p>
      </div>
      {manifest.categories?.length ? (
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Categories
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {manifest.categories.map((category) => (
              <span
                className="border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                key={category}
              >
                {category}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {manifest.agentBinary ? (
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Agent binary
          </h2>
          <p className="mt-2 font-mono text-sm">{manifest.agentBinary}</p>
        </div>
      ) : null}
      <div>
        <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Install command
        </h2>
        <div className="mt-2 overflow-hidden border border-border/70 bg-background/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="mr-2 text-foreground/40">$</span>
          <span className="break-all">{command}</span>
        </div>
      </div>
    </aside>
  );
}

function PluginScreenshots({ screenshots }: { screenshots: PluginImage[] }) {
  if (screenshots.length === 0) return null;
  return (
    <section className="grid gap-4 border-t pt-10 sm:grid-cols-2" aria-label="Screenshots">
      {screenshots.map((image) => (
        <div className="flex items-center justify-center border bg-background p-8" key={image.url}>
          <img className="max-h-96 max-w-full" alt={image.alt} src={image.url} />
        </div>
      ))}
    </section>
  );
}

function descriptionParagraphs(description: string | undefined): string[] {
  if (!description) return [];
  return description
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export default async function PluginDetailPage(props: PageProps<"/plugins/[...package]">) {
  const params = await props.params;
  const plugin = await findPlugin(params.package);
  if (!plugin) notFound();

  const { manifest } = plugin;
  // The lead already carries the short description — extra paragraphs only
  // exist when the lock's manifest ships extended copy.
  const paragraphs = descriptionParagraphs(manifest.longDescription);
  const [icon, ...screenshots] = manifest.images ?? [];
  const command = [manifest.install.command, ...(manifest.install.args ?? [])].join(" ");

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16 sm:py-24">
      <Link
        href={pluginsRoute}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← All plugins
      </Link>

      <PluginHeader plugin={plugin} icon={icon} />

      <div className="grid gap-12 py-10 md:grid-cols-[2fr_1fr]">
        <div>
          <p className="text-lg leading-7">{manifest.description}</p>
          {paragraphs.map((paragraph) => (
            <p className="mt-4 leading-6 text-muted-foreground" key={paragraph.slice(0, 32)}>
              {paragraph}
            </p>
          ))}
        </div>
        <PluginMetadata plugin={plugin} command={command} />
      </div>

      <PluginScreenshots screenshots={screenshots} />
    </main>
  );
}
