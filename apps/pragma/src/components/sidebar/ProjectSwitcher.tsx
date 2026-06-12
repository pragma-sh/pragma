import { Plus } from "lucide-react";
import { useWorkspace } from "@/state/workspace-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  onNewProject: () => void;
}

export function ProjectSwitcher({ onNewProject }: Props) {
  const { state, dispatch } = useWorkspace();

  return (
    <div className="flex items-center gap-2 border-t p-2">
      {state.projects.map((project, i) => {
        const isActive = project.id === state.activeProjectId;
        const icon = state.iconCache.get(project.id);

        return (
          <Tooltip key={project.id}>
            <TooltipTrigger asChild>
              <button
                title={project.name}
                onClick={() => dispatch({ type: "SET_ACTIVE_PROJECT", projectId: project.id })}
                className={`flex size-7 items-center justify-center rounded-md text-xs font-medium transition-all ${
                  isActive
                    ? "scale-110 bg-primary text-primary-foreground ring-2 ring-primary/40"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {icon ? (
                  <img src={icon} alt={project.name} className="size-4 object-contain" />
                ) : (
                  <span>{i + 1}</span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{project.name}</TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            title="New project"
            onClick={onNewProject}
            className="ml-auto flex size-7 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:bg-accent"
          >
            <Plus className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">New project</TooltipContent>
      </Tooltip>
    </div>
  );
}
