import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace-context";

export function ProjectSwitcher() {
  const workspace = useWorkspace();

  return (
    <div className="flex justify-center gap-2 overflow-x-auto pb-1" aria-label="Project switcher">
      {workspace.projects.map((project, index) => {
        const icon = workspace.icons[project.id];
        const active = project.id === workspace.selectedProjectId;
        return (
          <Button
            className={cn(
              "size-9 rounded-xl p-0",
              active &&
                "border-primary ring-2 ring-ring focus-visible:border-primary focus-visible:ring-0 focus-visible:ring-offset-0",
            )}
            key={project.id}
            title={project.name}
            variant={active ? "default" : "outline"}
            onClick={() => void workspace.selectProject(project.id)}
          >
            {icon ? (
              <img
                alt=""
                className={cn("size-5", active ? "brightness-0" : "brightness-0 invert")}
                src={`data:${icon.mime};base64,${icon.dataBase64}`}
              />
            ) : (
              <span className="text-xs font-semibold">{index + 1}</span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
