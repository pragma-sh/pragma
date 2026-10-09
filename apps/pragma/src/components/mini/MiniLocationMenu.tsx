import { useEffect } from "react";

import type { Project, Worktree } from "@pragma-sh/constants";
import { Check, FolderGit2, House } from "lucide-react";

import {
  isAtLocation,
  type MiniLocation,
  type MiniTab,
  worktreeLocation,
  worktreeName,
} from "@/components/mini/mini-tabs";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

/** Projects and their visible worktrees, as the mini window knows them. */
export interface MiniProjectCatalog {
  projects: Project[];
  worktrees: Record<string, Worktree[]>;
}

/** Where a tab can be re-homed to, and the directory its new shell starts in. */
export interface MiniDestination {
  location: MiniLocation;
  cwd: string;
}

/**
 * The tab context menu's "Open in Project" submenu: the home directory, then
 * every project with its worktrees. Choosing one restarts the tab's shell there
 * (see `relocateTab` in `MiniWindow`). It mounts when the context menu opens,
 * which is when `onOpen` asks for a fresh project list.
 */
export function MiniLocationMenu({
  tab,
  catalog,
  homeDir,
  onOpen,
  onSelect,
}: {
  tab: MiniTab;
  catalog: MiniProjectCatalog;
  homeDir: string | null;
  onOpen: () => void;
  onSelect: (destination: MiniDestination) => void;
}) {
  useEffect(onOpen, [onOpen]);
  const home: MiniLocation = { kind: "home" };
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderGit2 />
        Open in Project
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-96 min-w-56 overflow-y-auto">
        <ContextMenuItem
          disabled={!homeDir}
          onSelect={() => homeDir && onSelect({ location: home, cwd: homeDir })}
        >
          <House />
          <span className="flex-1">Home Directory</span>
          <CurrentMark show={isAtLocation(tab, home)} />
        </ContextMenuItem>
        <ContextMenuSeparator />
        {catalog.projects.length === 0 ? (
          <ContextMenuLabel className="text-muted-foreground font-normal">
            No projects yet
          </ContextMenuLabel>
        ) : (
          catalog.projects.map((project) => (
            <ProjectSubmenu
              key={project.id}
              onSelect={onSelect}
              project={project}
              tab={tab}
              worktrees={catalog.worktrees[project.id] ?? []}
            />
          ))
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function ProjectSubmenu({
  project,
  worktrees,
  tab,
  onSelect,
}: {
  project: Project;
  worktrees: Worktree[];
  tab: MiniTab;
  onSelect: (destination: MiniDestination) => void;
}) {
  const here = tab.location.kind === "worktree" && tab.location.projectId === project.id;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <span className="w-4 text-center">{project.iconEmoji ?? "📁"}</span>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <CurrentMark show={here} />
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-96 min-w-56 overflow-y-auto">
        {worktrees.length === 0 ? (
          <ContextMenuItem disabled>No worktrees</ContextMenuItem>
        ) : (
          worktrees.map((worktree) => {
            const location = worktreeLocation(project, worktree);
            return (
              <ContextMenuItem
                key={worktree.id}
                onSelect={() => onSelect({ location, cwd: worktree.path })}
              >
                <span className="min-w-0 flex-1 truncate">{worktreeName(worktree)}</span>
                {worktree.isMain ? (
                  <span className="text-muted-foreground text-xs">main</span>
                ) : null}
                <CurrentMark show={isAtLocation(tab, location)} />
              </ContextMenuItem>
            );
          })
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function CurrentMark({ show }: { show: boolean }) {
  return show ? <Check aria-label="Current" className="size-3.5" /> : null;
}
