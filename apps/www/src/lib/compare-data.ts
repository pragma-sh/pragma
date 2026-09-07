import { compareRoute, repoUrl } from "./shared";

export type Support = "yes" | "partial" | "no" | string;

export interface ComparisonRow {
  feature: string;
  detail: string;
  pragma: Support;
  emdash: Support;
  orca: Support;
  superset: Support;
}

/**
 * Feature matrix against the other open agent orchestrators. Cells were checked
 * against each project's own repository and docs (not only its marketing pages).
 * See `FOOTNOTE` below for what was checked and when — this is the one array
 * both the landing page's `Comparison` table and every `/compare/[slug]` page
 * render from, so a correction only has to happen in one place.
 */
export const ROWS: readonly ComparisonRow[] = [
  {
    feature: "Native shell",
    detail: "Rust host + the OS webview, not a bundled browser",
    pragma: "Tauri + Rust",
    emdash: "Electron",
    orca: "Electron",
    superset: "Electron",
  },
  {
    feature: "Agents as plugins",
    detail: "Each integration is its own versioned package with official branding",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Public plugin API",
    detail: "Third-party sidebar tabs, cards, web views, and commands in the app itself",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "no",
  },
  {
    feature: "Programmable automations",
    detail: "Your own TypeScript running on host events, not just a schedule",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Interactive agent scratchpads",
    detail: "Agents write MDX with live React components you can edit and comment on",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "no",
  },
  {
    feature: "Agent board",
    detail: "Prompt to review to pull request as tracked cards",
    pragma: "yes",
    emdash: "no",
    orca: "no",
    superset: "yes",
  },
  {
    feature: "Fan out + comparison view",
    detail: "One prompt into N attempts, compared as terminals, diffs, and scratchpads",
    pragma: "yes",
    emdash: "no",
    orca: "yes",
    superset: "partial",
  },
  {
    feature: "Editing suite",
    detail: "Code editor, markdown WYSIWYG, PDF, image, video, and audio viewers",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Built-in AI, your key",
    detail: "Inline ⌘K edits, one-click PR drafting, ask-anything from the palette",
    pragma: "yes",
    emdash: "no",
    orca: "partial",
    superset: "no",
  },
  {
    feature: "Mobile & web client",
    detail: "Platforms it ships, and how you reach it off your LAN",
    pragma: "iOS, Android, Web — own tunnel",
    emdash: "no",
    orca: "iOS, Android — Orca Relay (hosted) or LAN",
    superset: 'none yet — listed "coming soon"',
  },
  {
    feature: "Persistent host server",
    detail: "Sessions, tunnels, and headless launches survive quitting the app",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "Remote projects",
    detail: "SSH hosts as first-class remote projects",
    pragma: "SSH",
    emdash: "SSH",
    orca: "SSH + WSL",
    superset: "no",
  },
  {
    feature: "User themes",
    detail: "Editable colour tokens per project, not a fixed preset list",
    pragma: "yes",
    emdash: "partial",
    orca: "partial",
    superset: "partial",
  },
  {
    feature: "License",
    detail: "What you are allowed to do with the source",
    pragma: "AGPL-3.0",
    emdash: "Apache-2.0",
    orca: "MIT",
    superset: "Elastic 2.0",
  },
] as const;

export type CompetitorKey = "emdash" | "orca" | "superset";

export interface Competitor {
  key: CompetitorKey;
  slug: string;
  name: string;
  tagline: string;
  homepage: string;
  repo: string;
  license: string;
  logo: string;
  summary: readonly string[];
  migration: readonly { title: string; body: string }[];
}

/**
 * One entry per competitor in the main table. Checked against
 * `github.com/<repo>` (README, LICENSE, and linked docs) — not just each
 * project's marketing site — as of 2026-09-05.
 */
export const COMPETITORS: readonly Competitor[] = [
  {
    key: "emdash",
    slug: "emdash",
    name: "Emdash",
    tagline: "Open-source agentic development environment (YC W26)",
    homepage: "https://emdash.sh",
    repo: "generalaction/emdash",
    license: "Apache-2.0",
    logo: "/compare/emdash-icon.png",
    summary: [
      "Emdash is an Electron desktop app for running CLI coding agents — Claude Code, Codex, Cursor, OpenCode, and others — in parallel, each in its own git worktree and branch. It works with local projects and remote machines over SSH/SFTP, and can import tasks from a handful of project-management tools. It's Apache-2.0 licensed and keeps its state in a local SQLite database, with optional telemetry.",
      "Reviewing several agents at once means switching between their separate terminal sessions. Pragma adds a public plugin API, interactive scratchpads, an agent board, and a fan-out compare view on top of the same worktree model.",
      "Pragma is currently ahead on a few fronts: a public plugin API opens up third-party sidebar tabs and web views, agents write to interactive MDX scratchpads instead of just terminal output, a kanban-style board tracks work from prompt to pull request, a fan-out view lets you compare several attempts side by side, built-in AI handles inline edits and PR drafting, and there's a shipped mobile and web client.",
    ],
    migration: [
      {
        title: "Point Pragma at the same folder",
        body: "Emdash's worktrees are plain git worktrees under your project's `.git`. Open the parent repo as a Pragma project and its worktree list — and the branches Emdash already created — show up as-is; there's nothing to export.",
      },
      {
        title: "Your agent CLIs already work",
        body: "Pragma launches Claude Code, Codex, Cursor, and OpenCode using the CLI you already have installed and logged in — the same one Emdash was driving. No new API keys.",
      },
      {
        title: "Rebuild ticket-import wiring in the board",
        body: "Emdash's Linear/Jira/GitHub-issue import is Emdash-specific and doesn't export. Pragma's agent board and GitHub panel cover the same job — turn a task into a card, open a PR, review it — without leaving the app.",
      },
      {
        title: "Remove Emdash's agent hooks if you're not running both",
        body: "Emdash installs marker-tagged lifecycle hooks in each agent's user-level config to track status. They no-op outside an Emdash session, so it's safe to leave them, but Emdash's own docs cover removing them if you'd rather not.",
      },
    ],
  },
  {
    key: "orca",
    slug: "orca",
    name: "Orca",
    tagline:
      '"The AI Orchestrator for 100x builders" — Codex, Claude Code, OpenCode, or Pi in parallel worktrees',
    homepage: "https://onorca.dev",
    repo: "stablyai/orca",
    license: "MIT",
    logo: "/compare/orca-icon.png",
    summary: [
      'Orca is an Electron app supporting several coding agents (Claude Code, Codex, Cursor, OpenCode, and others), with a terminal, a browser pane whose "Design Mode" turns a clicked UI element into prompt context, SSH worktrees, and a CLI. It ships a mobile companion app (iOS App Store, Android APK, both beta) for monitoring agents from your phone, paired to a desktop or a self-hosted "Remote Orca Server" — reaching that desktop off your LAN means signing in to Orca\'s own hosted "Orca Relay," or running your own Tailscale/VPN.',
      "Orca tracks agent status per worktree rather than moving cards through a board, and its scheduled automations run on a cron rather than reacting to host events. Pragma adds a public plugin API, interactive scratchpads, an agent board, and a tunnel command you run yourself instead of a hosted relay.",
      "Pragma is currently ahead on a few fronts: a public plugin API, interactive MDX scratchpads, a kanban-style agent board, automations that react to host events rather than only a cron, and reaching a desktop off your LAN through a tunnel command you control instead of signing in to a required Orca Relay.",
    ],
    migration: [
      {
        title: "Same worktrees, no conversion",
        body: "Orca's \"Parallel Worktrees\" are git worktrees like everyone else's here. Open the repo in Pragma and every branch Orca created is already a project worktree.",
      },
      {
        title: "Re-pair your phone",
        body: "Pragma Go replaces Orca's paired mobile app: install it on iOS, Android, or open it in a browser, then point it at your own tunnel (ngrok, cloudflared, a Tailscale funnel) instead of signing in to Orca Relay.",
      },
      {
        title: "Rewrite Orca CLI scripts as `pragma-cli`",
        body: "`orca worktree create` / `snapshot` map to `pragma-cli`'s worktree and fanout commands, or to `@pragma/sdk` if the script runs from Node — see the CLI and SDK docs for the closest equivalent to each Orca command you rely on.",
      },
      {
        title: "SSH hosts carry over as-is",
        body: "If you reach a remote box through Orca's SSH worktrees, add the same host as a Pragma remote project — same credentials, same repo, same worktrees on disk.",
      },
    ],
  },
  {
    key: "superset",
    slug: "superset",
    name: "Superset",
    tagline: "Agentic IDE to orchestrate 100+ coding agents in parallel",
    homepage: "https://superset.sh",
    repo: "superset-sh/superset",
    license: "Elastic License 2.0",
    logo: "/compare/superset-icon.png",
    summary: [
      "Superset is an Electron app for running coding agents in parallel, each in its own git worktree. It has a board (columns for Idle, Working, Needs attention, Needs review, tied to agent and PR state), a diff viewer, an in-app browser, scheduled automations, and a CLI.",
      'Remote access runs through its own hosted "Superset Relay" — reaching a workspace on another machine needs an account on Superset\'s service, not a command you run yourself. Its own pricing page lists a mobile app as "Coming soon" on every plan; there\'s no shipped phone client today.',
      "It's also the only one of the three that isn't open source: Elastic License 2.0 is source-available, not OSI open source — you can read and modify it, but you may not offer it to others as a hosted service, and its license-key gating may not be circumvented. Like Emdash and Orca, it has no public plugin API or interactive scratchpads, and its fan-out is parallel workspaces without a unified compare view.",
      "Pragma is currently ahead on a few fronts: a public plugin API, interactive MDX scratchpads, a unified fan-out view for comparing attempts rather than separate parallel workspaces, built-in AI for inline edits and PR drafting, a shipped mobile and web client, SSH remote projects, and an AGPL-3.0 license that's fully open source rather than source-available.",
    ],
    migration: [
      {
        title: "Import is automatic",
        body: "Superset's workspaces are git worktrees. Open the same repository in Pragma and its existing branches appear as worktrees with no import step.",
      },
      {
        title: "Board columns map onto Pragma's board",
        body: "Superset's Idle / Working / Needs attention / Needs review columns are the same shape as Pragma's draft / in progress / review needed / completed — recreate your in-flight cards there and keep working the same way.",
      },
      {
        title: "Bring your own tunnel instead of Superset Relay",
        body: "Pragma's remote access is a command you already run — ngrok, cloudflared, a Tailscale funnel — rather than a vendor relay tied to a plan tier.",
      },
      {
        title: "Automations become event-driven, not just scheduled",
        body: "Superset's scheduled automations (nightly triage, weekly changelog) can be rebuilt as `@pragma/automations` scripts — the schedule still works, but you can also react to host events instead of only a cron.",
      },
    ],
  },
];

export function getCompetitor(slug: string): Competitor | undefined {
  return COMPETITORS.find((competitor) => competitor.slug === slug);
}

/** Route to one competitor's detail page. */
export function compareDetailRoute(slug: string): string {
  return `${compareRoute}/${slug}`;
}

/** Shown under every comparison table — what was checked, and what changed recently. */
export const FOOTNOTE = `Checked against the ${COMPETITORS.map((c) => c.repo).join(
  ", ",
)} repositories (README, LICENSE, and linked docs) as of 2026-08-29, with the mobile row re-verified on 2026-09-05 after both projects shipped changes: Orca added a hosted "Orca Relay" tunnel option, and Superset's own pricing page now lists its mobile app as "Coming soon" rather than shipped. This space moves fast — if something here is out of date, open an issue on ${repoUrl} and we will correct it.`;
