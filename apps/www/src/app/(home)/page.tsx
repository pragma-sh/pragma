import type { Metadata } from "next";

import { Bento } from "@/components/home/bento";
import { CodeCard } from "@/components/home/code-card";
import { Comparison } from "@/components/home/comparison";
import { CallToAction } from "@/components/home/cta";
import { PhoneFrame } from "@/components/home/device-frame";
import { FanoutGraph } from "@/components/home/fanout-graph";
import { GitHubMarks } from "@/components/home/github-marks";
import { Hero } from "@/components/home/hero";
import { FeaturePoint, FeatureSection, MediaImage, MediaVideo } from "@/components/home/section";
import { SiteFooter } from "@/components/home/site-footer";
import { TerminalCard, type TerminalLine } from "@/components/home/terminal-card";
import { appName } from "@/lib/shared";

export const metadata: Metadata = {
  title: { absolute: `${appName} — run teams of coding agents` },
  description:
    "Pragma is an agentic development environment: every coding agent in its own git worktree and native TUI, with an agent board, git and GitHub, editors, automations, and a plugin API around them.",
};

/** Sample session shown in the CLI section instead of a screen recording. */
const CLI_LINES: readonly TerminalLine[] = [
  { command: 'pragma-cli fanout create "Add token refresh" \\' },
  { command: "  --agent claude-code --agent codex --agent opencode" },
  { output: "fanout fan_8fa2 · 3 attempts · base main@f50343f", tone: "accent" },
  { output: "claude-code   running   fan/8fa2-claude-code" },
  { output: "codex         running   fan/8fa2-codex" },
  { output: "opencode      done      fan/8fa2-opencode", tone: "success" },
  { command: "pragma-cli agent report --agent dev started" },
  { output: "reported · status visible in the app and on your phone" },
];

/** Sample plugin shown in the extensibility section instead of a screen recording. */
const PLUGIN_SOURCE = `import { defineCommand, definePlugin, defineSidebarTab } from "@pragma/plugin";

import { ReviewQueue } from "./review-queue";

export default definePlugin({
  name: "Review Queue",
  description: "Everything waiting on me, across every worktree.",
  ui: {
    sidebarTabs: [
      defineSidebarTab({ id: "queue", title: "Queue", component: ReviewQueue }),
    ],
  },
  commands: [
    defineCommand({
      id: "review-queue.open",
      title: "Open review queue",
      defaultBinding: "mod+shift+r",
      run: (ctx) => ctx.notify("Review queue opened"),
    }),
  ],
});`;

/**
 * The landing page.
 *
 * The feature run is deliberately uniform: every section is the same layout on
 * the same surface, and only `flip` alternates, so the media walks right, left,
 * right down the page. Sections earn attention through their content, not
 * through each one looking unlike its neighbour. Everything from `Bento` down
 * keeps its own shape — those are not feature sections.
 */
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />

      <FeatureSection
        id="parallel"
        // The hero's reflection runs into this section, so the shell's top
        // hairline would cut straight across it.
        className="border-t-transparent"
        title="Every agent gets its own branch, terminal, and attention budget"
        description="Switch projects from the rail, launch any agent, and get told the moment it finishes. Every agent runs in an isolated worktree, so parallel work never collides."
        media={<MediaVideo src="/media/worktrees.mp4" />}
        points={
          <>
            <FeaturePoint title="Many projects, one window.">
              Run agents across every repository you work in from a single rail — switching projects
              never closes a session or costs you a second app.
            </FeaturePoint>
            <FeaturePoint title="Integrated and nested worktrees.">
              Pragma creates the git worktree and its branch for you, and a worktree can nest under
              another — so a follow-up task branches off the work in progress, not off main.
            </FeaturePoint>
            <FeaturePoint title="Real terminals, native TUIs.">
              Each agent runs its own CLI exactly as it ships — Claude Code, Codex, opencode, Cursor
              — in a GPU-accelerated terminal, alongside your dev servers, tests, and build scripts.
            </FeaturePoint>
            <FeaturePoint title="Status you can trust.">
              Plugins report running, done, and needs-you as coloured dots, a chime, and a system
              notification — so an idle agent never waits unnoticed.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="board"
        flip
        title="From task to pull request without leaving one screen"
        description="The board is a high-level alternative to managing agents through terminal tabs: turn tasks into cards, track progress across worktrees, and review results in one place."
        media={<MediaVideo src="/media/agent-board.mp4" />}
        points={
          <>
            <FeaturePoint title="Cards, not tabs.">
              A project-scoped board of prompts with enforced transitions: draft, in progress,
              review needed, completed.
            </FeaturePoint>
            <FeaturePoint title="Background launches.">
              Sessions spawn straight into the host server, so the board stays up while agents work;
              open a card later and the scrollback is all there.
            </FeaturePoint>
            <FeaturePoint title="Finish in one action.">
              Commit everything, draft the pull request with AI, push, and open it — the card keeps
              the PR number.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="fanout"
        title="Race your agents, keep the winner"
        description="One prompt, several isolated attempts under a coordination parent. Compare them side by side and merge the one that actually worked."
        background={
          <FanoutGraph className="absolute inset-0 opacity-40 [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]" />
        }
        media={<MediaVideo src="/media/fanout.mp4" />}
        points={
          <>
            <FeaturePoint title="One comparison grid.">
              Live terminals, diffs pinned to the base commit, and each attempt's scratchpads
              aligned in the same columns.
            </FeaturePoint>
            <FeaturePoint title="Pick a winner in one click.">
              Choose the strongest result and merge it back into the coordination worktree without
              leaving the comparison.
            </FeaturePoint>
            <FeaturePoint title="Agents can fan out too.">
              The Pragma skill lets agents create their own fanouts, monitor every attempt, and
              bring back the best result.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="git"
        flip
        title="Review code before it leaves your machine"
        description="Staged, unstaged, and committed changes with one unified diff per file, right beside the terminal the agent wrote them in."
        media={
          <MediaImage
            src="/media/diffs.png"
            alt="Pragma desktop app showing a side-by-side diff beside the staged changes panel"
            width={2718}
            height={1990}
          />
        }
        points={
          <>
            <FeaturePoint title="Diffs that follow the worktree.">
              Baselines resolve against the Pragma parent branch, so a moving main never scrambles
              your review.
            </FeaturePoint>
            <FeaturePoint title="Stage and commit in place.">
              Stage a file or the whole worktree, commit with a generated message, and push — no
              context switch to a second git client.
            </FeaturePoint>
            <FeaturePoint title="Know exactly what will ship.">
              Review the final branch diff against its parent before pushing, so generated changes
              never hide between commits.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="github"
        title="Ship the pull request without leaving the worktree"
        description="Pragma signs in to GitHub once, then the whole pull-request lifecycle — open, review, discuss, fix — happens beside the worktree the code came from."
        background={
          <GitHubMarks className="text-foreground/70 absolute inset-0 [mask-image:radial-gradient(130%_100%_at_50%_50%,black_55%,transparent)]" />
        }
        media={<MediaVideo src="/media/github.mp4" />}
        points={
          <>
            <FeaturePoint title="Open the PR from the worktree.">
              AI drafts the title and body from the actual diff; edit it in a markdown WYSIWYG, and
              pre-flight checks catch an uncommitted or unpushed branch before you submit.
            </FeaturePoint>
            <FeaturePoint title="Review it here.">
              Checks, commits, changed files, and review threads in one view — read every file as a
              unified diff, reply inline, and resolve threads from the app.
            </FeaturePoint>
            <FeaturePoint title="Fix with AI.">
              Flag review comments into a fix-it list and hand the whole list to an agent — in the
              same worktree, or on a fresh one it creates for the fix.
            </FeaturePoint>
            <FeaturePoint title="Stacks, not one giant branch.">
              A PR can sit on top of another, and Pragma links the stack from your local ancestor
              chain so each piece stays reviewable on its own.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="ai"
        flip
        title="Your key, your account, wired into the app"
        description="Pragma's own AI is small on purpose: it writes the commit, drafts the pull request, edits the file under your cursor, and answers the quick question — using your provider credentials."
        media={<MediaVideo src="/media/ai.mp4" />}
        points={
          <>
            <FeaturePoint title="Inline edit with ⌘K.">
              Select lines, describe the change, and review it as red/green hunks you accept or
              reject one at a time. Nothing touches disk until you save.
            </FeaturePoint>
            <FeaturePoint title="Auto-commit and push.">
              Let Pragma write the commit message, commit the worktree, and push the branch when the
              agent finishes.
            </FeaturePoint>
            <FeaturePoint title="Ask from the palette.">
              Type a question in the command palette and get a streamed answer scoped to the project
              and the worktree you are in.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="editing"
        title="Enough editor to never break flow"
        description="A file tree, a real code editor, a markdown WYSIWYG, and viewers for the things agents leave behind — then one click into the editor you actually live in."
        media={<MediaVideo src="/media/files.mp4" />}
        points={
          <>
            <FeaturePoint title="Files and edits.">
              Lazy file tree with inline create, rename, and delete; CodeMirror editors with syntax
              highlighting and explicit saves.
            </FeaturePoint>
            <FeaturePoint title="Markdown both ways.">
              A WYSIWYG mode with tables and task lists, and a raw mode sharing the same buffer, the
              same file, and the same ⌘K edits.
            </FeaturePoint>
            <FeaturePoint title="Viewers included.">
              PDFs render locally with a bundled engine; images, video, and audio open in a themed
              viewer. No CDN, no round trip.
            </FeaturePoint>
            <FeaturePoint title="Open in your editor.">
              VS Code, Cursor, Windsurf, Zed, Sublime Text, IntelliJ IDEA, or the file explorer —
              one click, right worktree.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="extend"
        flip
        title="A plugin API, not a settings page"
        description="Pragma's own agent integrations are plugins. Everything they use is public, so anything you build sits at the same level as what ships."
        media={<CodeCard title="review-queue/src/index.tsx" code={PLUGIN_SOURCE} />}
        points={
          <>
            <FeaturePoint title="Build your own workflow.">
              Add project tools to the sidebar, surface review queues as cards, open custom web
              views, and wire repeatable actions into the command palette.
            </FeaturePoint>
            <FeaturePoint title="Add an agent with a skill.">
              A shipped agent-plugin skill walks any coding agent through wiring a new CLI into
              Pragma — hooks, status, icons, verification.
            </FeaturePoint>
            <FeaturePoint title="Bring your own agent plugin.">
              Package any coding agent with its own launcher, icon, status reporting, and usage
              limits, then install it alongside the integrations that ship with Pragma.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="cli"
        title="Agents that operate the workspace itself"
        description="pragma-cli and @pragma/sdk make Pragma scriptable, so an agent can create the worktree, launch a peer, compare attempts, and publish a document for you to read."
        media={<TerminalCard title="agent@worktree — fan/8fa2" lines={CLI_LINES} />}
        points={
          <>
            <FeaturePoint title="One binary, installed for you.">
              Report status, create worktrees, fan out, merge, and stream another agent's output —
              from inside any Pragma terminal.
            </FeaturePoint>
            <FeaturePoint title="Round trips, not just events.">
              Agents ask questions and request command approval, then block on your answer through
              the same channel that renders it in the app and on your phone.
            </FeaturePoint>
            <FeaturePoint title="Scratchpads as output.">
              Instead of a wall of terminal text, an agent publishes interactive MDX you can edit,
              comment on, and reply into.
            </FeaturePoint>
          </>
        }
      />

      <FeatureSection
        id="go"
        flip
        title="Your workspace, from the couch"
        description="Turn on the tunnel and the local gateway becomes reachable from your phone — or from any browser, over a link you can share."
        media={
          <PhoneFrame>
            <MediaVideo
              className="rounded-none border-0 shadow-none md:scale-100 lg:scale-100"
              src="/media/go.mp4"
            />
          </PhoneFrame>
        }
        points={
          <>
            <FeaturePoint title="Self-hosted by default.">
              The gateway binds to localhost and is exposed only through a tunnel command you
              configure, with a bearer token you can regenerate.
            </FeaturePoint>
            <FeaturePoint title="Do real work.">
              Create worktrees, launch agents, watch running sessions, answer approvals and
              questions, and read scratchpads.
            </FeaturePoint>
            <FeaturePoint title="Your plugins come along.">
              Custom agents and their icons resolve on the phone exactly as they do on the desktop.
            </FeaturePoint>
            <FeaturePoint title="Also in a browser.">
              The same client ships as a web build the gateway serves, so a shared URL is all a
              second device needs.
            </FeaturePoint>
          </>
        }
      />

      <Bento />
      <Comparison />
      <CallToAction />
      <SiteFooter />
    </main>
  );
}
