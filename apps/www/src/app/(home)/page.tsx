import Link from "next/link";

import { HeroScene } from "@/components/hero-scene";
import { Button } from "@/components/ui/button";
import { appDescription } from "@/lib/shared";

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      <HeroScene className="pointer-events-none absolute inset-0 -z-10 opacity-70" />
      <h1 className="max-w-3xl text-balance text-5xl font-semibold tracking-tight">
        Ship with agents that stay put.
      </h1>
      <p className="text-fd-muted-foreground mt-6 max-w-xl text-balance text-lg">
        {appDescription}
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/docs">Read the docs</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="https://github.com/pragma-sh/pragma">View on GitHub</Link>
        </Button>
      </div>
    </main>
  );
}
