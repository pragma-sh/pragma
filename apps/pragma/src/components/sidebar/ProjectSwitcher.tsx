import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { isMacPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

/** First non-space character of `name`, uppercased; falls back to `?` for empty names. */
function leadingInitial(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : "?";
}

export function ProjectSwitcher() {
  const workspace = useWorkspace();
  const modifier = isMacPlatform() ? "⌃" : "Alt+";

  return (
    <TooltipProvider delayDuration={300}>
      <div
        aria-label="Project switcher"
        className="flex justify-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {workspace.projects.map((project, index) => {
          const icon = workspace.icons[project.id];
          const active = project.id === workspace.selectedProjectId;
          return (
            <Tooltip key={project.id}>
              <TooltipTrigger asChild>
                <button
                  aria-label={project.name}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md p-0",
                    "transition-colors focus-visible:outline-none",
                    active
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                  )}
                  onClick={() => void workspace.selectProject(project.id)}
                  type="button"
                >
                  {icon ? (
                    <img
                      alt=""
                      className={cn("size-4", active ? "brightness-0" : "brightness-0 invert")}
                      src={`data:${icon.mime};base64,${icon.dataBase64}`}
                    />
                  ) : (
                    <span className="text-xs font-semibold">{leadingInitial(project.name)}</span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {project.name}
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
        })}
      </div>
    </TooltipProvider>
  );
}
