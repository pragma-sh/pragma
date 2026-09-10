import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { SiteFooter } from "@/components/home/site-footer";
import { SupportForm } from "@/components/support/support-form";
import { privacyRoute } from "@/lib/legal";
import { supportResponseDays, supportRoute } from "@/lib/support";
import { appName, docsRoute, repoUrl } from "@/lib/shared";

export const metadata: Metadata = {
  title: "Support",
  description: `Get help with ${appName} and Pragma Go: contact the team, read the documentation, or open an issue. We reply within ${supportResponseDays} business days.`,
  // The URL submitted to App Store Connect as the Support URL, so the canonical
  // one has to match it exactly rather than whatever path a crawler arrived on.
  alternates: { canonical: supportRoute },
};

/** Self-serve destinations, offered before the form so a quick answer stays quick. */
const SELF_SERVE = [
  {
    title: "Documentation",
    description:
      "Setup, worktrees, agent plugins, the CLI, and the SDK. Start here for how something is meant to work.",
    href: docsRoute,
    cta: "Read the docs",
  },
  {
    title: "Known issues",
    description:
      "Bugs and requests we are tracking in the open. Someone may already have reported what you are seeing.",
    href: `${repoUrl}/issues`,
    cta: "Browse issues",
  },
  {
    title: "Discussions",
    description:
      "Questions, workflows, and plugin ideas answered by the maintainers and other people running agents.",
    href: `${repoUrl}/discussions`,
    cta: "Ask the community",
  },
] as const;

/** One self-serve card: heading, one line of scope, and a stretched link. */
function HelpCard({ item }: { item: (typeof SELF_SERVE)[number] }) {
  return (
    <article className="group border-border bg-card/40 hover:bg-card/70 relative flex flex-col gap-4 rounded-xl border p-6 transition-colors">
      <h3 className="text-lg font-medium tracking-tight">
        <Link
          href={item.href}
          className="underline-offset-4 after:absolute after:inset-0 group-hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {item.title}
        </Link>
      </h3>
      <p className="text-muted-foreground flex-1 text-sm leading-6">{item.description}</p>
      <span className="text-foreground relative z-10 inline-flex items-center gap-1.5 text-sm font-medium">
        {item.cta}
        <ArrowRight
          aria-hidden
          className="size-3.5 transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </article>
  );
}

/**
 * The support page.
 *
 * This is the URL given to App Store Connect as the Support URL for Pragma Go,
 * so it has to hold what App Review looks for: a way to reach a human, current
 * contact details, and answers about data and deletion — on the page itself,
 * not one redirect away. Self-serve links come first, the form second, and the
 * commitments we make about a reply last.
 */
export default function SupportPage() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto w-full max-w-6xl px-6 pt-16 pb-10 sm:pt-24">
        <p className="text-muted-foreground font-mono text-xs tracking-[0.2em] uppercase">
          {appName} Support
        </p>
        <h1 className="font-heading type-display-lg mt-4 max-w-3xl text-balance">
          Something not working? Tell us and we will get to it.
        </h1>
        <p className="text-muted-foreground mt-6 max-w-2xl text-base leading-7">
          Support covers {appName} on macOS, Linux, and Windows, and Pragma Go on iPhone, iPad,
          Android, and the browser. Send the form below and it reaches us directly. A person reads
          every request and replies by email within {supportResponseDays} business days.
        </p>
      </header>

      <section aria-labelledby="self-serve" className="border-border border-t px-6 py-16">
        <div className="mx-auto w-full max-w-6xl">
          <h2 id="self-serve" className="font-heading type-display-md text-balance">
            Answers you can get right now
          </h2>
          <p className="text-muted-foreground mt-4 max-w-2xl text-sm leading-6">
            Most questions are already answered in one of these three places, and they are faster
            than waiting on us.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {SELF_SERVE.map((item) => (
              <HelpCard key={item.title} item={item} />
            ))}
          </div>
        </div>
      </section>

      <section id="form" aria-labelledby="contact" className="border-border border-t px-6 py-16">
        <div className="mx-auto grid w-full max-w-6xl gap-12 lg:grid-cols-[2fr_3fr]">
          <div>
            <h2 id="contact" className="font-heading type-display-md text-balance">
              Contact support
            </h2>
            <p className="text-muted-foreground mt-4 text-sm leading-6">
              Every field marked optional can be left blank. The more precisely you can describe
              what you expected and what happened instead, the fewer rounds it takes.
            </p>
            <dl className="border-border mt-8 grid gap-5 border-t pt-8 text-sm">
              <div>
                <dt className="font-medium">Response time</dt>
                <dd className="text-muted-foreground mt-1 leading-6">
                  Within {supportResponseDays} business days, to the address you give us.
                </dd>
              </div>
            </dl>
          </div>
          <div className="border-border bg-card/40 rounded-xl border p-6 sm:p-8">
            <SupportForm />
          </div>
        </div>
      </section>

      <section aria-labelledby="data" className="border-border border-t px-6 py-16">
        <div className="mx-auto grid w-full max-w-6xl gap-10 md:grid-cols-3">
          <div>
            <h2 id="data" className="font-heading type-display-md text-balance">
              Your data, and getting rid of it
            </h2>
            <p className="text-muted-foreground mt-4 text-sm leading-6">
              The full rules are in the{" "}
              <Link className="text-foreground underline underline-offset-4" href={privacyRoute}>
                privacy policy
              </Link>
              .
            </p>
          </div>
          <div className="text-sm leading-6 md:col-span-2">
            <h3 className="font-medium">There is no account to delete</h3>
            <p className="text-muted-foreground mt-2">
              Neither app asks you to register. Your projects, terminals, and agent transcripts stay
              on machines you control, and Pragma Go talks only to the copy of {appName} you paired
              it with. Unpairing removes the stored connection details from the device and revokes
              it on the desktop.
            </p>
            <h3 className="mt-6 font-medium">What a support request leaves behind</h3>
            <p className="text-muted-foreground mt-2">
              The message you send here is delivered to our support inbox and kept only as long as
              it takes to resolve your request. Ask us to delete it at any point, and we will,
              including the copy in the inbox.
            </p>
            <h3 className="mt-6 font-medium">Please leave secrets out</h3>
            <p className="text-muted-foreground mt-2">
              Do not paste access tokens, API keys, passwords, or private source into the form.
              Redact them from logs first. If you need to send something sensitive, say so and we
              will arrange a channel for it.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="specialist" className="border-border border-t px-6 py-16">
        <div className="mx-auto grid w-full max-w-6xl gap-10 md:grid-cols-3">
          <div>
            <h2 id="specialist" className="font-heading type-display-md text-balance">
              Security and accessibility
            </h2>
          </div>
          <div className="text-sm leading-6 md:col-span-2">
            <h3 className="font-medium">Reporting a vulnerability</h3>
            <p className="text-muted-foreground mt-2">
              Send it through the form above and choose &ldquo;A security or privacy concern&rdquo;
              rather than opening a public issue &mdash; the form is private, and an issue is not.
              We acknowledge security reports within {supportResponseDays} business days and will
              tell you when a fix ships.
            </p>
            <h3 className="mt-6 font-medium">Accessibility barriers</h3>
            <p className="text-muted-foreground mt-2">
              If anything in {appName}, Pragma Go, or this site is unusable with VoiceOver,
              TalkBack, a keyboard, or at your text size, report it the same way and mark it as an
              accessibility problem. We treat those as defects, not as feature requests.
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
