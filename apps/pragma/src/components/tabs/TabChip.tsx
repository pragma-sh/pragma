import type { DragEventHandler, ReactNode } from "react";
import { motion } from "motion/react";

import type { Tab } from "@pragma-sh/constants";
import { Pencil, X } from "lucide-react";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { ShortcutHint } from "@/components/ShortcutHint";
import { TabDirtyDot, TabIcon, tabTitle } from "@/components/tabs/tab-label";
import { TabRenameInput } from "@/components/tabs/TabRenameInput";
import type { TabRenameApi } from "@/components/tabs/use-tab-rename";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconTooltip } from "@/components/ui/icon-button";
import { motionTransition, tabItemVariants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";

/**
 * The single highlight that marks the active tab. It is one element shared
 * across the current tab set via `layoutId`, so activating another tab slides
 * it there. Callers include the current tab ids in the id, which prevents a
 * close from animating the highlight onto the fallback tab.
 */
const ACTIVE_TAB_LAYOUT_ID = "terminal-tab-active";

/** The layout id for a strip showing `tabs` (see {@link ACTIVE_TAB_LAYOUT_ID}). */
export function activeTabLayoutIdFor(tabs: readonly Tab[]): string {
  return `${ACTIVE_TAB_LAYOUT_ID}:${tabs.map((tab) => tab.id).join(",")}`;
}

/** The sliding highlight behind the active tab. */
export function ActiveTabHighlight({ layoutId }: { layoutId: string }) {
  return (
    <motion.span
      aria-hidden
      className="absolute inset-0 rounded-md border border-border bg-elevated"
      layoutId={layoutId}
      transition={motionTransition.indicator}
    />
  );
}

/** Shared chrome for a top-bar entry: fixed metrics plus the active/idle colouring. */
export function tabEntryClassName(active: boolean): string {
  return cn(
    "group relative mr-1 flex h-8 min-w-32 max-w-52 items-center gap-1.5 rounded-md border border-transparent px-2 text-sm",
    active ? "text-foreground" : "text-muted-foreground hover:bg-muted",
  );
}

/** A tab's live agent status dot. */
export function TabAgentDot({ tabId }: { tabId: string }) {
  // `relative` keeps the dot above the absolutely-positioned active highlight.
  return <AgentStatusDot className="relative" status={useTabAgentStatus(tabId)} />;
}

/** Native HTML5 drag handlers for a draggable chip. */
export interface TabChipDrag {
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragEnd: () => void;
}

/**
 * One tab in a top-bar strip: icon, agent dot, title (or rename field), close
 * button, and a context menu with Rename, the caller's `menuItems`, and Close.
 * The workspace strip and the Pragma Mini strip both render it, so the two
 * cannot drift apart.
 */
export function TabChip({
  tab,
  active,
  activeTabLayoutId,
  rename,
  shortcutHint = null,
  drag,
  menuItems,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  activeTabLayoutId: string;
  rename: TabRenameApi;
  shortcutHint?: string | null;
  drag?: TabChipDrag;
  /** Extra context-menu entries, between Rename and Close. */
  menuItems?: ReactNode;
  onSelect: () => void;
  onClose: () => void;
}) {
  const displayTitle = tabTitle(tab);
  const isRenaming = tab.id === rename.renamingTabId;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* The HTML5 drag handlers stay on a plain wrapper: a motion component
            replaces `onDragStart`/`onDragEnd` with its own pan-gesture
            signatures, which are not the native DragEvent this uses. */}
        <div
          className="shrink-0"
          draggable={drag ? true : undefined}
          onDragEnd={drag?.onDragEnd}
          onDragStart={drag?.onDragStart}
        >
          <motion.div
            animate="visible"
            className={tabEntryClassName(active)}
            exit="exit"
            initial="hidden"
            transition={motionTransition.fast}
            variants={tabItemVariants}
          >
            {active ? <ActiveTabHighlight layoutId={activeTabLayoutId} /> : null}
            {isRenaming ? (
              <TabRenameInput className="text-sm" rename={rename} />
            ) : (
              <button
                className="relative flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={onSelect}
                onDoubleClick={() => rename.startRename(tab.id, displayTitle)}
              >
                <TabIcon tab={tab} />
                <TabAgentDot tabId={tab.id} />
                <ShortcutHint value={shortcutHint} />
                <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
              </button>
            )}
            <TabDirtyDot tabId={tab.id} />
            <IconTooltip label="Close tab">
              <button
                aria-label="Close tab"
                className="relative rounded p-0.5 opacity-60 transition-opacity hover:bg-muted hover:opacity-100"
                onClick={onClose}
              >
                <X className="size-3" />
              </button>
            </IconTooltip>
          </motion.div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => rename.startRenameFromMenu(tab.id, displayTitle)}>
          <Pencil />
          Rename
        </ContextMenuItem>
        {menuItems}
        <ContextMenuItem onSelect={onClose}>
          <X />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
