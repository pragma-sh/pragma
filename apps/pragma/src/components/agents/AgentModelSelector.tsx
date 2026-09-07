import { Pin, PinOff } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import {
  NestedDropdown,
  NestedDropdownGroup,
  NestedDropdownItem,
} from "@/components/NestedDropdown";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-button";
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

/** Nested agent → searchable model → reasoning selector shared by launch dialogs. */
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
    <NestedDropdown
      modal={false}
      trigger={
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
      }
    >
      {agents.length === 0 ? (
        <NestedDropdownItem disabled>No agents configured</NestedDropdownItem>
      ) : (
        agents.map((agent) => (
          <AgentSubmenu
            key={agent.id}
            agent={agent}
            models={modelsByAgent[agent.id]}
            selection={agent.id === value.agentId ? value.selection : null}
            onChange={onChange}
            onLoadModels={onLoadModels}
          />
        ))
      )}
    </NestedDropdown>
  );
}

function AgentSubmenu({
  agent,
  models,
  selection,
  onChange,
  onLoadModels,
}: {
  agent: AgentConfig;
  models: AgentModel[] | undefined;
  selection: AgentModelSelection | null;
  onChange: (agentId: string, selection: AgentModelSelection) => void;
  onLoadModels: (agentId: string) => void;
}) {
  const pins = useModelPins();
  const orderedModels = models ? sortModelsByPin(agent.id, models, pins) : models;
  return (
    <NestedDropdownGroup
      emptyText="No matching models."
      label={
        <>
          <AgentIcon agent={agent} />
          <span className="truncate">{agent.name}</span>
        </>
      }
      searchLabel="Search models"
      searchPlaceholder="Search models..."
      searchValue={agent.name}
      searchable
      onOpen={() => onLoadModels(agent.id)}
    >
      {orderedModels === undefined ? (
        <NestedDropdownItem disabled>Loading models...</NestedDropdownItem>
      ) : orderedModels.length > 0 ? (
        orderedModels.map((model) => (
          <ModelChoice
            key={model.id}
            agent={agent}
            model={model}
            selected={selection?.modelId === model.id}
            selectedReasoningId={selection?.modelId === model.id ? selection.reasoningId : null}
            onChange={onChange}
          />
        ))
      ) : (
        <NestedDropdownItem disabled>No models found</NestedDropdownItem>
      )}
    </NestedDropdownGroup>
  );
}

function ModelChoice({
  agent,
  model,
  selected,
  selectedReasoningId,
  onChange,
}: {
  agent: AgentConfig;
  model: AgentModel;
  selected: boolean;
  selectedReasoningId: string | null;
  onChange: (agentId: string, selection: AgentModelSelection) => void;
}) {
  const pinButton = <ModelPinButton agent={agent} model={model} />;
  const searchValue = `${model.name} ${model.id}`;
  if (model.reasoning.length === 0) {
    return (
      <NestedDropdownItem
        searchValue={searchValue}
        selected={selected}
        onSelect={() => onChange(agent.id, { modelId: model.id, reasoningId: null })}
      >
        {pinButton}
        <span className="min-w-0 flex-1 truncate">{model.name}</span>
      </NestedDropdownItem>
    );
  }
  return (
    <NestedDropdownGroup
      label={
        <>
          {pinButton}
          <span className="min-w-0 flex-1 truncate">{model.name}</span>
        </>
      }
      searchValue={searchValue}
    >
      <NestedDropdownItem
        selected={selected && selectedReasoningId === null}
        onSelect={() => onChange(agent.id, { modelId: model.id, reasoningId: null })}
      >
        Auto
      </NestedDropdownItem>
      {model.reasoning.map((reasoning) => (
        <NestedDropdownItem
          key={reasoning.id}
          selected={selected && selectedReasoningId === reasoning.id}
          onSelect={() => onChange(agent.id, { modelId: model.id, reasoningId: reasoning.id })}
        >
          {reasoning.name}
        </NestedDropdownItem>
      ))}
    </NestedDropdownGroup>
  );
}

/** Pin toggle shown to the left of each model; pins float the model to the top. */
function ModelPinButton({ agent, model }: { agent: AgentConfig; model: AgentModel }) {
  const pinned = isModelPinned(agent.id, model.id);
  return (
    <IconTooltip label={pinned ? "Unpin" : "Pin"}>
      <button
        aria-label={pinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleModelPin(agent.id, model.id);
        }}
      >
        {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
      </button>
    </IconTooltip>
  );
}
