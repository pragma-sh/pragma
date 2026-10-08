import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AppStoreButton } from "@/components/app-store-button";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { PhoneFrame } from "@/components/home/device-frame";
import { FeaturePoint, FeatureSection, Reveal, SectionShell } from "@/components/home/section";
import { SiteFooter } from "@/components/home/site-footer";
import { AndroidMark } from "@/components/platform-marks";
import { Button } from "@/components/ui/button";
import { MOBILE_COLUMNS, MOBILE_FOOTNOTE, MOBILE_ROWS } from "@/lib/mobile-compare";
import {
  androidInstallRoute,
  appName,
  appStoreUrl,
  docsRoute,
  mobileRoute,
  repoUrl,
  siteUrl,
} from "@/lib/shared";

const TITLE = "Pragma Go — Claude Code and Codex from your phone";
const DESCRIPTION =
  "Free iOS, Android, and web app for your coding agents: live terminals, approvals, fanouts, diffs, and pull requests, over your own tunnel. No account.";
const OG_IMAGE = "/media/go/og.png";
const WEB_ACCESS_DOCS = `${docsRoute}/user-guide/mobile#pragma-go-on-the-web`;
const MOBILE_DOCS = `${docsRoute}/user-guide/mobile`;

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  keywords: [
    "Pragma Go",
    "coding agent mobile app",
    "Claude Code on iPhone",
    "Codex mobile",
    "remote control coding agents",
    "AI coding agent iOS app",
    "AI coding agent Android app",
    "Superset mobile alternative",
    "Orca mobile alternative",
  ],
  alternates: { canonical: mobileRoute },
  openGraph: {
    type: "website",
    url: mobileRoute,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Pragma Go on three iPhones" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
  appLinks: { ios: { url: appStoreUrl, app_store_id: "6804842149" } },
  itunes: { appId: "6804842149" },
};

/** One screenshot as the native app renders it, at the simulator's 1206×2622 capture size. */
function PhoneShot({ src, alt, priority }: { src: string; alt: string; priority?: boolean }) {
  return (
    <PhoneFrame className="max-w-[17rem]">
      <Image
        src={src}
        alt={alt}
        width={1206}
        height={2622}
        sizes="(min-width: 1024px) 272px, 70vw"
        priority={priority}
        className="h-auto w-full"
      />
    </PhoneFrame>
  );
}

/** Questions people search for before installing — rendered on the page and as FAQPage data. */
const FAQ: readonly { question: string; answer: string }[] = [
  {
    question: "Is Pragma Go free?",
    answer:
      "Yes. Pragma Go is free on the App Store, as a signed APK for Android, and as a web app your own desktop serves. There is no paid tier and no plan gate on any feature.",
  },
  {
    question: "Do I need an account to use it?",
    answer:
      "No. You pair the phone with your desktop by scanning a QR code in Settings → Pragma Go. The code carries your tunnel URL and a token that only your desktop issued; there is no Pragma account and no Pragma server in between.",
  },
  {
    question: "How does my phone reach my computer when I'm away from home?",
    answer:
      "Through a tunnel command you choose. The default is ngrok, and anything that prints a URL works — cloudflared, a Tailscale funnel, your own reverse proxy. The desktop's gateway only listens on localhost, and every data route needs the bearer token.",
  },
  {
    question: "Which coding agents does it work with?",
    answer:
      "Every agent Pragma runs: Claude Code, Codex, opencode, Cursor, GitHub Copilot CLI, Grok, Kimi Code, Junie, Pi, Prime Agent, and any agent you add with a plugin. Your custom agents and their icons show up on the phone exactly as they do on the desktop.",
  },
  {
    question: "Do the agents run on my phone?",
    answer:
      "No. Agents keep running on your computer, in their own git worktrees, with your own subscriptions. The phone is a client: it attaches to the same sessions, so closing the app never stops an agent and work started on the phone is waiting on the desktop when you sit back down.",
  },
  {
    question: "Can I use it without installing anything?",
    answer:
      "Yes. Turn on web access and your desktop serves the same client to any browser. The link carries the token in the URL fragment, which browsers never send to a server, so it can be opened on a borrowed laptop or a tablet.",
  },
  {
    question: "How is Pragma Go different from Superset Mobile and Orca Mobile?",
    answer:
      "Pragma Go is free, runs on iOS, Android, and the web, and connects through a tunnel you run rather than a hosted relay. It is also the only one of the three that fans one prompt out to several agents and compares their attempts, runs project scripts, and publishes the pull request from the phone. The full table is on this page.",
  },
];

/**
 * Structured data for search: the app itself (so the listing can show price
 * and platforms) and the FAQ above. Built from the same constants the page
 * renders, so the two never drift.
 */
const STRUCTURED_DATA = [
  {
    "@context": "https://schema.org",
    "@type": "MobileApplication",
    name: "Pragma Go",
    alternateName: "Pragma Sh Go",
    description: DESCRIPTION,
    url: new URL(mobileRoute, siteUrl).toString(),
    image: new URL(OG_IMAGE, siteUrl).toString(),
    operatingSystem: "iOS, iPadOS, Android, Web",
    applicationCategory: "DeveloperApplication",
    downloadUrl: appStoreUrl,
    installUrl: appStoreUrl,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: appName, url: siteUrl, sameAs: [repoUrl] },
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  },
];

/** `JSON.stringify` leaves `<` alone, which would let a `</script>` in copy end the tag early. */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The three ways in, shared by the hero and the closing call to action. */
function InstallActions() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <AppStoreButton />
      <Button asChild variant="secondary" className="pill-cta gap-2">
        <Link href={androidInstallRoute}>
          <AndroidMark className="size-4" />
          Android
        </Link>
      </Button>
      <Button asChild variant="secondary" className="pill-cta">
        <Link href={WEB_ACCESS_DOCS}>Open in a browser</Link>
      </Button>
    </div>
  );
}

/**
 * The Pragma Go landing page.
 *
 * Every screenshot is the real app, captured from the iOS simulator against a
 * live host. Follows the home page's vocabulary: the feature run is
 * `FeatureSection` alternating `flip`, and the page closes on the one
 * spotlight card.
 */
export default function MobilePage() {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static, page-owned data; `jsonLd` escapes `<` so copy cannot close the tag.
        dangerouslySetInnerHTML={{ __html: jsonLd(STRUCTURED_DATA) }}
      />

      <header className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-16 text-center sm:pt-24">
        <p className="text-muted-foreground font-mono text-xs tracking-[0.2em] uppercase">
          Pragma Go · iOS · Android · Web
        </p>
        <h1 className="font-heading type-display-lg mt-4 max-w-4xl text-balance">
          Pragma Go: your coding agents, from your phone
        </h1>
        <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-[1.3]">
          Watch Claude Code, Codex, and every other agent work in real terminals, answer what they
          are blocked on, race one prompt across several of them, and ship the pull request — while
          they keep running on your own computer. Free, no account, over a tunnel you control.
        </p>
        <div className="mt-8">
          <InstallActions />
        </div>

        <div className="mt-16 grid w-full grid-cols-1 items-end gap-6 sm:grid-cols-3 sm:gap-8">
          <Reveal className="hidden sm:block">
            <PhoneShot
              src="/media/go/terminal.webp"
              alt="Pragma Go showing a live shell terminal with git log output and a key bar with ctrl, esc, tab, and Ctrl-C"
              priority
            />
          </Reveal>
          <Reveal delay={0.06}>
            <PhoneShot
              src="/media/go/fanout-compare.webp"
              alt="Pragma Go comparing a fanout's attempts from Claude Code, Codex, and Cursor, with the files each one changed"
              priority
            />
          </Reveal>
          <Reveal delay={0.12} className="hidden sm:block">
            <PhoneShot
              src="/media/go/diff.webp"
              alt="Pragma Go showing a syntax-highlighted diff of a CSS file an agent changed"
              priority
            />
          </Reveal>
        </div>
      </header>

      <FeatureSection
        id="terminals"
        title="Real terminals, not a status page"
        description="Open any shell or script the host is running and type into it. The phone renders with the same emulator as the desktop, so a TUI looks exactly like it does at your desk."
        media={
          <PhoneShot
            src="/media/go/terminal.webp"
            alt="A live terminal in Pragma Go with the extra-keys bar above the keyboard"
          />
        }
        points={
          <>
            <FeaturePoint title="The keys a phone keyboard lacks.">
              Escape, Tab, Ctrl-C, arrows, and a sticky Ctrl sit above the keyboard — with Ctrl-D
              kept well away from the interrupt key.
            </FeaturePoint>
            <FeaturePoint title="Shares the screen without fighting it.">
              The phone borrows the terminal's size while you look and hands it back when you leave,
              so the desktop's layout is untouched.
            </FeaturePoint>
            <FeaturePoint title="Survives a dropped signal.">
              Reconnecting replays only the output you missed, and a keystroke whose delivery was
              uncertain is never sent twice.
            </FeaturePoint>
            <FeaturePoint title="Open, rename, and close tabs.">
              A terminal opened on the phone is a real tab on the desktop too.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="fanout"
        flip
        title="Race your agents from the couch"
        description="Send one prompt to several agents, each in its own worktree, then compare what they did and keep the best one — the same fanout the desktop runs, started from your phone."
        media={
          <PhoneShot
            src="/media/go/fanout-launch.webp"
            alt="The Pragma Go launch sheet in Fan out mode with Claude Code and Codex attempts"
          />
        }
        points={
          <>
            <FeaturePoint title="One agent, model, and effort per attempt.">
              Two Claude Codes on different models, or Claude Code against Codex — mix them however
              you like.
            </FeaturePoint>
            <FeaturePoint title="Swipe between attempts.">
              Each attempt's status, scratchpads, and every file it changed, one page each.
            </FeaturePoint>
            <FeaturePoint title="Pick, retry, or follow up.">
              Merge the winner, restart a straggler with its work intact, or send a follow-up to
              every attempt at once.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="review"
        title="Read the diff before it ships"
        description="Browse any worktree's files and every change an agent made, with the desktop's syntax highlighting — then commit and open the pull request without walking back to your desk."
        media={
          <PhoneShot
            src="/media/go/diff.webp"
            alt="A file diff in Pragma Go with added lines highlighted"
          />
        }
        points={
          <>
            <FeaturePoint title="Commit &amp; PR in the safe order.">
              AI groups the changes into logical commits, you review the pull request text, and only
              then does anything leave your machine.
            </FeaturePoint>
            <FeaturePoint title="Runs on the host, not the phone.">
              Lock the screen or lose signal mid-commit and the run carries on; the sheet tells you
              how many commits it already made.
            </FeaturePoint>
            <FeaturePoint title="Pull request status at a glance.">
              A worktree whose branch has a pull request shows it — even one opened on the web —
              with merged told apart from closed.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="scripts"
        flip
        title="Start the dev server, then open it"
        description="Run the project's scripts from the worktree header, and every port they open is one tap from your phone's browser."
        media={
          <PhoneShot
            src="/media/go/scripts.webp"
            alt="The Pragma Go project scripts menu listing build, mobile, run, and www"
          />
        }
        points={
          <>
            <FeaturePoint title="One run per script.">
              Tap Run while the dev server is already up and you get that run, not a second one
              fighting for the port.
            </FeaturePoint>
            <FeaturePoint title="Forward a port, then design on it.">
              Open a running app through your tunnel, tap the paintbrush, pick an element, and hand
              the change to an agent.
            </FeaturePoint>
            <FeaturePoint title="Accounts and usage.">
              Every agent account, how much of its plan is left, and which one each agent launches
              with — switchable from the home screen.
            </FeaturePoint>
          </>
        }
      />

      <SectionShell id="compare">
        <div className="mx-auto max-w-5xl">
          <Reveal>
            <h2 className="font-heading type-display-md text-balance">
              Pragma Go vs Superset Mobile vs Orca Mobile
            </h2>
            <p className="text-muted-foreground mt-4 max-w-3xl text-lg leading-[1.3]">
              All three let you check on agents from your phone. The difference is how you reach
              your computer, what it costs, and how much work you can actually finish there.
            </p>
          </Reveal>
          <div className="border-border bg-card mt-8 overflow-x-auto rounded-xl border">
            <ComparisonTable
              rows={MOBILE_ROWS}
              pragmaLabel="Pragma Go"
              columns={MOBILE_COLUMNS}
              capabilityClassName="w-[40%] min-w-56"
            />
          </div>
          <p className="text-muted-foreground mt-6 max-w-3xl text-sm leading-relaxed">
            Where the others are ahead: Orca Mobile can keep several desktops paired at once and
            seals pairing end to end with its own keys, and both Orca and Superset take dictated and
            photo replies in their composers. Pragma Go reaches one desktop at a time, over the
            tunnel you run.
          </p>
          <p className="text-muted-foreground mt-4 text-xs">{MOBILE_FOOTNOTE}</p>
        </div>
      </SectionShell>

      <SectionShell id="faq">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="font-heading type-display-md text-balance">Questions</h2>
          </Reveal>
          <div className="divide-border border-border mt-8 divide-y border-y">
            {FAQ.map((item) => (
              <details key={item.question} className="group py-5">
                <summary className="text-foreground flex cursor-pointer list-none items-center justify-between gap-6 font-medium">
                  <h3>{item.question}</h3>
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{item.answer}</p>
              </details>
            ))}
          </div>
          <p className="text-muted-foreground mt-6 text-sm">
            Setup, pairing, and every screen are in the{" "}
            <Link href={MOBILE_DOCS} className="text-foreground underline underline-offset-4">
              Pragma Go docs
            </Link>
            .
          </p>
        </div>
      </SectionShell>

      <SectionShell>
        <div className="spotlight rounded-panel mx-auto max-w-5xl px-6 py-16 text-center sm:px-16 sm:py-20">
          <h2 className="font-heading type-display-md mx-auto max-w-2xl text-balance">
            Leave the desk. Keep shipping.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg leading-[1.3]">
            Pair once with a QR code from Settings → Pragma Go on the desktop.
          </p>
          <div className="mt-8">
            <InstallActions />
          </div>
        </div>
      </SectionShell>

      <SiteFooter />
    </main>
  );
}
