import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { Worktree } from "@pragma-sh/constants";
import type { PluginWorktree } from "@pragma-sh/plugin";

import { CountProbe } from "@/lib/count-probe";
import { createToggleSetStore } from "@/lib/external-set-store";
import { useDisclosureVariants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  RenderPluginContribution,
  RenderPluginCount,
  usePluginWorktreeSections,
} from "@/plugins/rendering";
import { useCompactWorktreeRows } from "@/state/sidebar-preferences";
import { portsSection } from "./PortsSection";
import { scratchpadsSection } from "./ScratchpadsSection";
import type { BuiltInWorktreeSection, RowSection } from "./types";
import { whiteboardsSection } from "./WhiteboardsSection";

/** Pragma's own sections, ahead of any plugin's, in chip order. */
const BUILT_IN_SECTIONS: readonly BuiltInWorktreeSection[] = [
  portsSection,
  whiteboardsSection,
  scratchpadsSection,
];

/** Which (worktree, section) bodies are expanded. Cosmetic, per-device state. */
const expandedStore = createToggleSetStore("pragma.worktreeSections");

function expandedId(worktreeId: string, sectionKey: string): string {
  return `${worktreeId}\0${sectionKey}`;
}

/** What a row needs to render its sections. */
export interface WorktreeRowSections {
  /**
   * Count hooks, one per section. Mount them wherever the row always renders:
   * they must run even while the row shows no details at all.
   */
  probes: ReactNode;
  /** The chips and expanded bodies for the row's details, or undefined when there are none. */
  panel: ReactNode | undefined;
}

/** The row's worktree in the shape plugins read through `useWorktree()`. */
function usePluginWorktree(worktree: Worktree, label: string, selected: boolean): PluginWorktree {
  const { id, projectId, branch, path, isMain } = worktree;
  return useMemo(
    () => ({ id, projectId, title: label, branch, path, isMain, selected }),
    [id, projectId, label, branch, path, isMain, selected],
  );
}

function useRowSections(worktree: PluginWorktree, enabled: boolean): RowSection[] {
  const plugins = usePluginWorktreeSections(worktree.projectId, worktree);
  return useMemo(() => {
    if (!enabled) return [];
    return [
      ...BUILT_IN_SECTIONS.map(
        (section): RowSection => ({
          key: `builtin:${section.id}`,
          title: section.title,
          icon: section.icon,
          source: "builtin",
          section,
        }),
      ),
      ...plugins.map(
        (contribution): RowSection => ({
          key: contribution.key,
          title: contribution.contribution.title,
          icon: contribution.contribution.icon,
          source: "plugin",
          contribution,
        }),
      ),
    ];
  }, [enabled, plugins]);
}

/** Whether a section reports a count; an uncounted plugin section always shows, unbadged. */
function isCounted(section: RowSection): boolean {
  return section.source === "builtin" || section.contribution.contribution.useCount !== undefined;
}

/**
 * A worktree row's sections: built-in Ports, Whiteboards, and Scratchpads plus
 * every plugin `worktreeSections` contribution. Each section with something to
 * show gets a chip in the row's details; a chip expands its body inline. The
 * compact layout shows none of them.
 */
export function useWorktreeRowSections(
  worktree: Worktree,
  label: string,
  selected: boolean,
): WorktreeRowSections {
  const compact = useCompactWorktreeRows();
  const pluginWorktree = usePluginWorktree(worktree, label, selected);
  const sections = useRowSections(pluginWorktree, !compact);
  const [counts, setCounts] = useState<Readonly<Record<string, number | null>>>({});
  const report = useCallback((key: string, count: number | null) => {
    setCounts((previous) => (previous[key] === count ? previous : { ...previous, [key]: count }));
  }, []);

  const shown = sections.filter((section) => !isCounted(section) || (counts[section.key] ?? 0) > 0);
  return {
    probes: sections.map((section) => (
      <SectionCountProbe
        key={section.key}
        report={report}
        section={section}
        worktree={pluginWorktree}
      />
    )),
    panel:
      shown.length > 0 ? (
        <WorktreeSectionsPanel counts={counts} sections={shown} worktree={pluginWorktree} />
      ) : undefined,
  };
}

function SectionCountProbe({
  section,
  worktree,
  report,
}: {
  section: RowSection;
  worktree: PluginWorktree;
  report: (key: string, count: number | null) => void;
}) {
  const onCount = useCallback(
    (count: number | null) => report(section.key, count),
    [report, section.key],
  );
  const args = useMemo((): [PluginWorktree] => [worktree], [worktree]);
  if (section.source === "builtin") {
    return <CountProbe args={args} onCount={onCount} useCount={section.section.useCount} />;
  }
  const { contribution } = section;
  if (!contribution.contribution.useCount) return null;
  return (
    <RenderPluginCount
      args={args}
      config={contribution.record.config}
      onCount={onCount}
      pluginId={contribution.pluginId}
      resetKey={contribution.key}
      useCount={contribution.contribution.useCount}
      worktree={worktree}
    />
  );
}

function WorktreeSectionsPanel({
  worktree,
  sections,
  counts,
}: {
  worktree: PluginWorktree;
  sections: RowSection[];
  counts: Readonly<Record<string, number | null>>;
}) {
  const expanded = expandedStore.useSnapshot();
  const open = sections.filter((section) => expanded.has(expandedId(worktree.id, section.key)));
  return (
    <div className="flex min-w-0 flex-col" data-slot="worktree-sections">
      <div className="-ml-1 flex flex-wrap items-center gap-1">
        {sections.map((section) => (
          <SectionChip
            count={isCounted(section) ? counts[section.key] : undefined}
            key={section.key}
            open={expanded.has(expandedId(worktree.id, section.key))}
            section={section}
            worktreeId={worktree.id}
          />
        ))}
      </div>
      <AnimatePresence initial={false}>
        {open.map((section) => (
          <SectionBody key={section.key} section={section} worktree={worktree} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** A section's toggle: its icon and count (or its title when it has no icon or count). */
function SectionChip({
  section,
  count,
  open,
  worktreeId,
}: {
  section: RowSection;
  count: number | null | undefined;
  open: boolean;
  worktreeId: string;
}) {
  const Icon = section.icon;
  const badged = typeof count === "number";
  return (
    <button
      aria-expanded={open}
      aria-label={badged ? `${section.title} (${count})` : section.title}
      className={cn(
        "flex h-5 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground",
        open && "bg-sidebar-foreground/10 text-sidebar-foreground",
      )}
      title={section.title}
      type="button"
      onClick={() => expandedStore.toggle(expandedId(worktreeId, section.key))}
    >
      {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
      {!Icon || !badged ? <span className="truncate">{section.title}</span> : null}
      {badged ? <span>{count}</span> : null}
    </button>
  );
}

/**
 * A section's expanded body. The chip already names it, so there is no
 * header; the height animates open and closed like the app's collapsibles.
 */
function SectionBody({ section, worktree }: { section: RowSection; worktree: PluginWorktree }) {
  const variants = useDisclosureVariants();
  return (
    // The animated box owns only height + overflow; the border and padding sit
    // inside it, or they would keep the collapsed box taller than zero.
    <motion.section
      animate="expanded"
      aria-label={section.title}
      className="min-w-0 overflow-hidden"
      data-slot="worktree-section"
      exit="collapsed"
      initial="collapsed"
      variants={variants}
    >
      <div className="pt-1">
        <div className="min-w-0 border-l border-sidebar-border pl-2">
          {section.source === "builtin" ? (
            <section.section.Body worktree={worktree} />
          ) : (
            <RenderPluginContribution
              component={section.contribution.contribution.component}
              config={section.contribution.record.config}
              pluginId={section.contribution.pluginId}
              resetKey={`${section.contribution.key}:${worktree.id}`}
              worktree={worktree}
            />
          )}
        </div>
      </div>
    </motion.section>
  );
}
