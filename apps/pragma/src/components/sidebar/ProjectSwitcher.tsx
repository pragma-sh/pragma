import { useEffect, useRef, type Ref } from "react";
import { Trash2 } from "lucide-react";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { ShortcutHint } from "@/components/ShortcutHint";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/errors";
import { isMacPlatform } from "@/lib/platform";
import { removeProject } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useProjectAgentStatus } from "@/state/agent-status-store";
import { useWorkspace } from "@/state/workspace-context";
import { useShortcutHint } from "@/lib/shortcut-hints";
import { toast } from "sonner";

/** First non-space character of `name`, uppercased; falls back to `?` for empty names. */
function leadingInitial(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : "?";
}

export function ProjectSwitcher() {
  const workspace = useWorkspace();
  const modifier = isMacPlatform() ? "⌃" : "Alt+";
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Keep the selected project visible when the strip overflows — cycling with
  // ⌃1…9 or a swipe can land on an icon scrolled out of view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selectedProjectId]);

  async function handleRemoveProject(projectId: string) {
    try {
      await removeProject(projectId);
      await workspace.reload();
    } catch (cause) {
      toast.error(`Failed to remove project: ${errorMessage(cause)}`);
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        aria-label="Project switcher"
        className="overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        // The sidebar cycles projects on horizontal wheel/swipe gestures. Over
        // the strip itself those gestures mean "scroll the icons", so they stop
        // here rather than bubbling up and switching project under the cursor.
        onTouchEnd={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {/* `mx-auto` on a max-content row centres a short list without making an
            overflowing one unreachable the way `justify-center` would. */}
        <div className="mx-auto flex w-max gap-1.5">
          {workspace.projects.map((project, index) => {
            const icon = workspace.icons[project.id];
            const active = project.id === workspace.selectedProjectId;
            return (
              <ProjectButton
                active={active}
                icon={icon ?? null}
                index={index}
                key={project.id}
                modifier={modifier}
                name={project.name}
                onRemove={() => handleRemoveProject(project.id)}
                onSelect={() => workspace.selectProject(project.id)}
                ref={active ? activeRef : undefined}
                worktreeIds={(workspace.worktrees[project.id] ?? []).map((worktree) => worktree.id)}
              />
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

interface ProjectButtonProps {
  active: boolean;
  icon: ReturnType<typeof useWorkspace>["icons"][string];
  index: number;
  modifier: string;
  name: string;
  onRemove: () => Promise<void>;
  onSelect: () => Promise<void>;
  ref?: Ref<HTMLButtonElement>;
  worktreeIds: string[];
}

function ProjectButton({
  active,
  icon,
  index,
  modifier,
  name,
  onRemove,
  onSelect,
  ref,
  worktreeIds,
}: ProjectButtonProps) {
  const status = useProjectAgentStatus(worktreeIds);
  const shortcutHint = useShortcutHint("project", index < 9 ? index + 1 : null);
  return (
    <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              aria-label={name}
              aria-pressed={active}
              className={cn(
                "relative flex size-7 shrink-0 items-center justify-center rounded-md p-0",
                "transition-colors focus-visible:outline-none",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
              onClick={() => void onSelect()}
              ref={ref}
              type="button"
            >
              {icon ? (
                <span
                  aria-hidden="true"
                  className="size-4 bg-current"
                  style={{
                    maskImage: `url(data:${icon.mime};base64,${icon.dataBase64})`,
                    WebkitMaskImage: `url(data:${icon.mime};base64,${icon.dataBase64})`,
                    maskSize: "contain",
                    WebkitMaskSize: "contain",
                    maskRepeat: "no-repeat",
                    WebkitMaskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskPosition: "center",
                  }}
                />
              ) : (
                <span className="text-xs font-semibold">{leadingInitial(name)}</span>
              )}
              <AgentStatusDot className="absolute top-0 right-0" status={status} />
              <ShortcutHint className="absolute inset-1 z-10" value={shortcutHint} />
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onSelect={() => void onRemove()}>
            <Trash2 />
            Remove project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TooltipContent>
        {name}
        <kbd
          data-slot="kbd"
          className="bg-background/15 rounded px-1 text-[10px] font-medium uppercase"
        >
          {modifier}
          {index + 1}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}
