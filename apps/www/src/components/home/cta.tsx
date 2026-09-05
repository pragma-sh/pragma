import Link from "next/link";
import { BookOpen, Download } from "lucide-react";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { docsRoute, repoUrl } from "@/lib/shared";
import { Reveal } from "./section";

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
