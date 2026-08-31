import Link from "next/link";
import { BookOpen, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { docsRoute, gitConfig } from "@/lib/shared";
import { Reveal } from "./section";

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** GitHub mark; lucide dropped brand glyphs, so the path lives here. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.2c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.23 1.91 1.23 3.23 0 4.63-2.8 5.65-5.48 5.95.43.37.82 1.1.82 2.22v3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

/**
 * Closing call to action, drawn as the page's one gradient spotlight card (`DESIGN.md` → Components → Gradient Spotlight Cards).
 *
 * The gradient is the CARD, not the section: the band underneath it stays on
 * canvas like every other section, which is the rule that keeps the device
 * reading as an atmospheric panel instead of a themed room. This is the only
 * one on the page — the device works because it is scarce.
 */
export function CallToAction() {
  return (
    <section className="border-border relative isolate overflow-hidden border-t px-6 py-20 sm:py-24">
      <Reveal className="mx-auto max-w-6xl">
        <div className="spotlight rounded-panel px-6 py-20 text-center sm:px-16 sm:py-28">
          <h2 className="font-heading type-display-lg mx-auto max-w-3xl text-balance">
            Stop babysitting one agent at a time.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-[1.3] text-muted-foreground text-balance">
            Open a project, fan a prompt across your agents, and come back to pull requests.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button className="pill-cta gap-2">
              <Download className="size-4" />
              Download Pragma
            </Button>
            <Button asChild variant="secondary" className="pill-cta gap-2">
              <Link href={docsRoute}>
                <BookOpen className="size-4" />
                View docs
              </Link>
            </Button>
            <Button asChild variant="secondary" className="pill-cta gap-2">
              <Link href={repoUrl}>
                <GithubMark className="size-4" />
                GitHub
              </Link>
            </Button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
