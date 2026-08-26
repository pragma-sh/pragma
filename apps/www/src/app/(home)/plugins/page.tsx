import type { Metadata } from "next";

import { PluginCard } from "@/components/plugin-card";
import { loadOfficialPlugins } from "@/lib/plugins";

export const metadata: Metadata = {
  title: "Plugins | Pragma",
  description: "Browse reviewed plugins for Pragma and install them into the desktop app.",
};

export default async function PluginsPage() {
  const plugins = await loadOfficialPlugins();

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-16 sm:py-24">
      <header className="grid gap-8 border-b pb-10 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Official index / {plugins.length.toString().padStart(2, "0")}
          </p>
          <h1 className="mt-4 max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Add tools without rebuilding your workspace.
          </h1>
        </div>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground md:text-right">
          Every entry is pinned to an npm release and reviewed manifest. Pragma shows exact install
          command before anything runs.
        </p>
      </header>

      <section className="grid border-l border-t sm:grid-cols-2" aria-label="Official plugins">
        {plugins.map((plugin) => (
          <div className="border-b border-r" key={plugin.package}>
            <PluginCard plugin={plugin} />
          </div>
        ))}
      </section>
    </main>
  );
}
