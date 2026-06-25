import { Pin, PinOff } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelSelectionLabel } from "@/lib/agent-model-selection";
import type { AgentConfig, AgentModel, AgentModelSelection } from "@/lib/tauri";
import { isModelPinned, sortModelsByPin, toggleModelPin, useModelPins } from "@/state/model-pins";

interface AgentModelSelectorProps {
  agents: AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  value: { agentId: string | null; selection: AgentModelSelection };
  onChange: (agentId: string, selection: AgentModelSelection) => void;
  onLoadModels: (agentId: string) => void;
  onInteract?: () => void;
  label?: string;
}

/** Nested agent -> model -> reasoning selector shared by agent-launch dialogs. */
export function AgentModelSelector({
  agents,
  modelsByAgent,
  value,
  onChange,
  onLoadModels,
  onInteract,
  label = "Agent",
}: AgentModelSelectorProps) {
  const selectedAgent = agents.find((agent) => agent.id === value.agentId) ?? null;
  const selectedModels = selectedAgent ? (modelsByAgent[selectedAgent.id] ?? []) : [];
  // Non-modal: this selector always lives inside our own modal dialog overlay. A
  // modal Radix menu locks `body { pointer-events: none }` and can leave it stuck
  // after closing, which blocks sibling controls (e.g. the worktree Select).
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          className="h-8 w-full justify-between gap-2 px-2.5 font-normal"
          onKeyDown={onInteract}
          onPointerDown={onInteract}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {selectedAgent ? (
              <>
                <AgentIcon agent={selectedAgent} />
                <span className="truncate">{selectedAgent.name}</span>
                <span className="truncate text-muted-foreground">
                  / {modelSelectionLabel(selectedModels, value.selection)}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Select agent</span>
            )}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {agents.length === 0 ? (
          <DropdownMenuItem disabled>No agents configured</DropdownMenuItem>
        ) : (
          agents.map((agent) => (
            <AgentSubmenu
              key={agent.id}
              agent={agent}
              models={modelsByAgent[agent.id]}
              onChange={onChange}
              onLoadModels={onLoadModels}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentSubmenu({
  agent,
  models,
  onChange,
  onLoadModels,
}: {
  agent: AgentConfig;
  models: AgentModel[] | undefined;
  onChange: (agentId: string, selection: AgentModelSelection) => void;
  onLoadModels: (agentId: string) => void;
}) {
  const pins = useModelPins();
  const orderedModels = models ? sortModelsByPin(agent.id, models, pins) : models;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        onFocus={() => onLoadModels(agent.id)}
        onPointerEnter={() => onLoadModels(agent.id)}
      >
        <AgentIcon agent={agent} />
        <span className="truncate">{agent.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        {orderedModels === undefined ? (
          <DropdownMenuItem disabled>Loading models...</DropdownMenuItem>
        ) : orderedModels.length > 0 ? (
          orderedModels.map((model) => (
            <ModelChoice key={model.id} agent={agent} model={model} onChange={onChange} />
          ))
        ) : (
          <DropdownMenuItem disabled>No models found</DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ModelChoice({
  agent,
  model,
  onChange,
}: {
  agent: AgentConfig;
  model: AgentModel;
  onChange: (agentId: string, selection: AgentModelSelection) => void;
}) {
  const modelSelection = { modelId: model.id, reasoningId: null };
  const pinButton = <ModelPinButton agent={agent} model={model} />;
  if (model.reasoning.length === 0) {
    return (
      <DropdownMenuItem className="gap-1.5" onSelect={() => onChange(agent.id, modelSelection)}>
        {pinButton}
        <span className="min-w-0 flex-1 truncate">{model.name}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-1.5">
        {pinButton}
        <span className="min-w-0 flex-1 truncate">{model.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-44">
        <DropdownMenuLabel>{model.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(agent.id, modelSelection)}>
          Auto
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {model.reasoning.map((reasoning) => (
          <DropdownMenuItem
            key={reasoning.id}
            onSelect={() => onChange(agent.id, { modelId: model.id, reasoningId: reasoning.id })}
          >
            {reasoning.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Pin toggle shown to the left of each model; pins float the model to the top. */
function ModelPinButton({ agent, model }: { agent: AgentConfig; model: AgentModel }) {
  const pinned = isModelPinned(agent.id, model.id);
  return (
    <button
      type="button"
      className="rounded p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleModelPin(agent.id, model.id);
      }}
      aria-label={pinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
    >
      {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
    </button>
  );
}
