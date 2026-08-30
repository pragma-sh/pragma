import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Bot,
  Braces,
  Columns3,
  Compass,
  Gauge,
  Globe,
  Keyboard,
  NotebookPen,
  Server,
  TerminalSquare,
  Workflow,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Reveal, SectionHeading, SectionShell } from "./section";

interface BentoItem {
  icon: LucideIcon;
  title: string;
  description: string;
  /**
   * Column span on the 12-column grid. Rows are hand-packed to 12 so the grid
   * is deliberately uneven rather than a uniform card wall.
   */
  span: string;
}

const ITEMS: readonly BentoItem[] = [
  {
    icon: Globe,
    title: "SSH projects",
    description:
      "Open a project on another machine and its terminals, files, git, and search all run there. On Windows, WSL distributions are shells you can pick per project.",
    span: "sm:col-span-6 lg:col-span-7",
  },
  {
    icon: TerminalSquare,
    title: "Project scripts",
    description:
      "Setup, run, and build commands live in .pragma/scripts.json, run per worktree, and their open ports surface in the sidebar and the palette.",
    span: "sm:col-span-6 lg:col-span-5",
  },
  {
    icon: Workflow,
    title: "Automations",
    description:
      "React to host events instead of polling: auto-review a PR the moment it opens, restart a crashed dev server, or ping your phone when an agent needs input.",
    span: "sm:col-span-6 lg:col-span-4",
  },
  {
    icon: Bot,
    title: "Agent skills",
    description:
      "Shipped skills teach any agent how to build a Pragma plugin, write a scratchpad, or diagnose latency, so onboarding an agent is a prompt, not a manual.",
    span: "sm:col-span-6 lg:col-span-4",
  },
  {
    icon: Braces,
    title: "TypeScript SDK",
    description:
      "@pragma/sdk is a typed client for the local gateway: sessions, files, git, agents, scratchpads, and a duplex channel to a running agent.",
    span: "sm:col-span-12 lg:col-span-4",
  },
  {
    icon: NotebookPen,
    title: "Scratchpads",
    description:
      "Agents show their work instead of walls of text: live charts, diff reviews, and question cards you edit and comment on in place.",
    span: "sm:col-span-6 lg:col-span-7",
  },
  {
    icon: Server,
    title: "Persistent app server",
    description:
      "Like tmux, but for your agents: close the desktop app and your sessions, automations, and phone link all keep running.",
    span: "sm:col-span-6 lg:col-span-5",
  },
  {
    icon: Compass,
    title: "Command palette",
    description:
      "One box for worktrees, tabs, agents, pull requests, filenames, code search, running scripts, open ports, and a one-shot AI answer.",
    span: "sm:col-span-6 lg:col-span-5",
  },
  {
    icon: Columns3,
    title: "Splits and tabs",
    description:
      "Terminals, editors, diffs, and native browser views split any direction, persist per worktree, and reattach after a restart.",
    span: "sm:col-span-6 lg:col-span-4",
  },
  {
    icon: Bell,
    title: "Agent alerts",
    description:
      "A chime, a system notification, and a status dot the moment an agent finishes or needs a decision — with your own sound clips per project.",
    span: "sm:col-span-12 lg:col-span-3",
  },
  {
    icon: Keyboard,
    title: "Keybindings",
    description:
      "Every action is rebindable per platform, globally or per project, validated on write so a bad chord can never lock you out.",
    span: "sm:col-span-6 lg:col-span-6",
  },
  {
    icon: Gauge,
    title: "Usage limits",
    description:
      "Plugins report provider quota, so the remaining window for each agent subscription is one click away in the tab bar.",
    span: "sm:col-span-6 lg:col-span-6",
  },
];

/**
 * The rest of the product, as a hand-packed bento grid.
 *
 * This is the page's band of charcoal cards — the rhythm break comes from what
 * stands on the canvas, not from tinting the canvas, so the section ground is
 * the same near-black as its neighbours. Every tile is the same card: no
 * featured tile, no spotlight tile. Twelve items with one of them singled out
 * asserted a ranking the list does not have, and it spent the page's gradient
 * allowance on a footnote — the closing call to action is the one spotlight now.
 */
export function Bento() {
  return (
    <SectionShell id="more">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <SectionHeading
            align="center"
            title="The parts that make it a workspace"
            description="Thoughtful details that make every session smoother."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-12">
          {ITEMS.map((item, index) => (
            <Reveal key={item.title} delay={Math.min(index, 5) * 0.04} className={cn(item.span)}>
              <Card className="border-border bg-card hover:border-muted-foreground h-full gap-4 p-6 transition-colors">
                <item.icon className="text-muted-foreground size-5" />
                <div>
                  <h3 className="text-base font-medium">{item.title}</h3>
                  <p className="text-muted-foreground mt-2 text-sm leading-[1.4]">
                    {item.description}
                  </p>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </SectionShell>
  );
}
