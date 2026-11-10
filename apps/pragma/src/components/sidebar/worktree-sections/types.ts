import type { ComponentType } from "react";

import type { PluginWorktree, WorktreeSectionDefinition } from "@pragma-sh/plugin";

import type { VisiblePluginContribution } from "@/plugins/rendering";

/** An icon a section shows on its chip and body header. */
export type SectionIcon = ComponentType<{ className?: string }>;

/**
 * A section Pragma itself ships (Ports, Whiteboards, Scratchpads). It mirrors
 * the plugin `WorktreeSectionDefinition`, except the body receives its row as
 * a prop instead of through `useWorktree()`, and every built-in is counted.
 */
export interface BuiltInWorktreeSection {
  id: string;
  title: string;
  icon: SectionIcon;
  useCount: (worktree: PluginWorktree) => number | null;
  Body: ComponentType<{ worktree: PluginWorktree }>;
}

/** One section a worktree row may show, built-in or plugin-contributed. */
export type RowSection =
  | {
      key: string;
      title: string;
      icon?: SectionIcon;
      source: "builtin";
      section: BuiltInWorktreeSection;
    }
  | {
      key: string;
      title: string;
      icon?: SectionIcon;
      source: "plugin";
      contribution: VisiblePluginContribution<WorktreeSectionDefinition>;
    };
