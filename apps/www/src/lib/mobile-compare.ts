import type { Support } from "./compare-data";
import { repoUrl } from "./shared";

/** One capability row comparing the three phone clients. */
export interface MobileComparisonRow {
  feature: string;
  detail: string;
  pragma: Support;
  superset: Support;
  orca: Support;
}

/**
 * Pragma Go against the other agent orchestrators' phone apps. Checked against
 * Superset's launch post (superset.sh/blog/superset-mobile) and Orca's mobile
 * docs (onorca.dev/docs/mobile) on {@link MOBILE_VERIFIED_ON}. A "no" means the
 * capability is absent from that project's own documentation, not that we
 * tested its app — say so in {@link MOBILE_FOOTNOTE} if that ever changes.
 */
export const MOBILE_ROWS: readonly MobileComparisonRow[] = [
  {
    feature: "Platforms",
    detail: "Where the client runs today",
    pragma: "iOS, iPadOS, Android, Web",
    superset: "iPhone (iOS 26+)",
    orca: "iOS, Android (beta)",
  },
  {
    feature: "Price",
    detail: "What it costs to use the phone client",
    pragma: "Free",
    superset: "Pro plan, $20/seat/mo",
    orca: "Free",
  },
  {
    feature: "Reaching your computer off your LAN",
    detail: "The path between the phone and the machine running the agents",
    pragma: "Your own tunnel",
    superset: "Hosted relay",
    orca: "Hosted relay or LAN",
  },
  {
    feature: "No account required",
    detail: "Pair the phone with the desktop and nothing else",
    pragma: "yes",
    superset: "no",
    orca: "partial",
  },
  {
    feature: "Runs in a browser",
    detail: "Open the same client from a link, with nothing to install",
    pragma: "yes",
    superset: "no",
    orca: "no",
  },
  {
    feature: "Live terminals",
    detail: "Attach to a running shell or agent session and type into it",
    pragma: "yes",
    superset: "yes",
    orca: "yes",
  },
  {
    feature: "Create worktrees and launch agents",
    detail: "Start new work from the phone, not only watch it",
    pragma: "yes",
    superset: "yes",
    orca: "yes",
  },
  {
    feature: "Fan out and compare attempts",
    detail: "One prompt to several agents, compared side by side, best one merged",
    pragma: "yes",
    superset: "no",
    orca: "no",
  },
  {
    feature: "Approve commands and answer questions",
    detail: "Resolve what an agent is blocked on, as an inbox",
    pragma: "yes",
    superset: "partial",
    orca: "yes",
  },
  {
    feature: "Review diffs",
    detail: "Read what an agent changed, file by file",
    pragma: "yes",
    superset: "yes",
    orca: "yes",
  },
  {
    feature: "Commit and open the pull request",
    detail: "AI-written commits, a reviewed PR draft, then publish",
    pragma: "yes",
    superset: "partial",
    orca: "partial",
  },
  {
    feature: "Project scripts and dev-server previews",
    detail: "Start the dev server, then open its port on the phone",
    pragma: "yes",
    superset: "no",
    orca: "partial",
  },
  {
    feature: "Agent accounts and usage limits",
    detail: "See plan usage and switch the account an agent launches with",
    pragma: "yes",
    superset: "no",
    orca: "yes",
  },
  {
    feature: "Home Screen widgets",
    detail: "Agents waiting on you, without opening the app",
    pragma: "yes",
    superset: "no",
    orca: "no",
  },
  {
    feature: "License",
    detail: "What you may do with the source",
    pragma: "AGPL-3.0",
    superset: "Elastic 2.0",
    orca: "MIT",
  },
] as const;

/** When the rows above were last checked against each project's own pages. */
export const MOBILE_VERIFIED_ON = "2026-10-06";

/** Shown under the mobile comparison table. */
export const MOBILE_FOOTNOTE = `Checked on ${MOBILE_VERIFIED_ON} against Superset's mobile launch post and pricing, and Orca's mobile documentation. "No" means the capability is not in that project's own documentation. Superset Mobile launched on 2026-09-21; its Android app is on a waitlist. Orca's relay needs a sign-in; its LAN mode does not. If something here is out of date, open an issue on ${repoUrl} and we will correct it.`;
