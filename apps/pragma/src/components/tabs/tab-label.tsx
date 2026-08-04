import { useMemo, useState } from "react";

import type { Tab } from "@pragma/constants";
import { Icon } from "@iconify/react";
import {
  GitPullRequest,
  Globe,
  PanelsTopLeft,
  ScrollText,
  SquareTerminal,
  StickyNote,
  type LucideIcon,
} from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { useAgentsList } from "@/hooks/use-agents-list";
import { fileIconId } from "@/lib/file-icons";
import { basename } from "@/lib/path";
import { defaultTabTitle } from "@/lib/tab-title";
import { useTabDirty } from "@/state/editor-dirty-store";

/** The display title for a tab: file name for editor/diff, else its label. */
export function tabTitle(tab: Tab): string {
  if ((tab.kind === "editor" || tab.kind === "diff") && tab.filePath) {
    const name = basename(tab.filePath);
    if (tab.kind === "diff") {
      const sideLabel =
        tab.diffSide === "committed"
          ? "Committed"
          : tab.diffSide === "staged"
            ? "Staged"
            : "Working";
      return `${name} (${sideLabel})`;
    }
    return name;
  }
  // A blank title (a shell/page that cleared its name) falls back to the
  // default too, not just a null one.
  return tab.title?.trim() || defaultTabTitle(tab.kind);
}

const ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

/** Tab kinds whose icon depends only on the kind. */
const STATIC_TAB_ICONS: Partial<Record<Tab["kind"], LucideIcon>> = {
  log: ScrollText,
  "plugin-webview": PanelsTopLeft,
  "pr-review": GitPullRequest,
  scratchpad: StickyNote,
};

/**
 * Renders a tab kind icon, using the launched agent's icon for agent terminal
 * tabs and the page favicon for browser tabs when available.
 */
export function TabIcon({ tab }: { tab: Tab }) {
  const [failed, setFailed] = useState(false);
  const agents = useAgentsList();
  const agent = tab.agentId ? agents.find((candidate) => candidate.id === tab.agentId) : undefined;
  const favicon = useMemo(() => faviconUrl(tab.kind, tab.url), [tab.kind, tab.url]);

  const StaticIcon = STATIC_TAB_ICONS[tab.kind];
  if (StaticIcon) return <StaticIcon className={ICON_CLASS} />;

  if (tab.kind === "editor" || tab.kind === "diff") {
    return <Icon className="size-3.5 shrink-0" icon={fileIconId(basename(tab.filePath ?? ""))} />;
  }

  if (tab.kind !== "browser") {
    if (agent) return <AgentIcon agent={agent} className="size-3.5 shrink-0" />;
    return <SquareTerminal className={ICON_CLASS} />;
  }

  if (!favicon || failed) return <Globe className={ICON_CLASS} />;

  return (
    <img
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      src={favicon}
      onError={() => setFailed(true)}
    />
  );
}

/** The favicon a browser tab's page would serve, or null when it has no usable URL. */
function faviconUrl(kind: Tab["kind"], url: string | null): string | null {
  if (!url || kind !== "browser") return null;
  try {
    return new URL("/favicon.ico", url).href;
  } catch {
    return null;
  }
}

/** A small dot shown next to a tab's close button while it has unsaved edits. */
export function TabDirtyDot({ tabId }: { tabId: string }) {
  const dirty = useTabDirty(tabId);
  if (!dirty) {
    return null;
  }
  return (
    <output
      aria-label="Unsaved changes"
      className="block size-2 shrink-0 rounded-full bg-primary"
    />
  );
}
