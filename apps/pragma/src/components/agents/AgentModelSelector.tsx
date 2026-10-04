import { useCallback, useState } from "react";

import { Pin, PinOff, Sparkles } from "lucide-react";

import { AgentIcon } from "@/components/agents/AgentIcon";
import {
  NestedDropdown,
  NestedDropdownGroup,
  NestedDropdownItem,
} from "@/components/NestedDropdown";
import { Button } from "@/components/ui/button";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-button";
import {
  type AutoRegistry,
  type AutoSelectTarget,
  useAutoAgentSelection,
} from "@/hooks/use-auto-agent-selection";
import {
  modelSelectionLabel,
  readAutoModePreference,
  rememberAutoModePreference,
} from "@/lib/agent-model-selection";
import type { AgentConfig, AgentModel, AgentModelSelection } from "@/lib/tauri";
import { isModelPinned, sortModelsByPin, toggleModelPin, useModelPins } from "@/state/model-pins";
import { useSystem1Status } from "@/state/system1";

/** Passed as `onChange`'s third argument when auto mode (not the user) made the pick. */
interface AgentSelectionChangeMeta {
  auto: true;
}

interface AgentModelSelectorProps {
  agents: AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  value: { agentId: string | null; selection: AgentModelSelection };
  onChange: (
    agentId: string,
    selection: AgentModelSelection,
    meta?: AgentSelectionChangeMeta,
  ) => void;
  onLoadModels: (agentId: string) => void;
  onInteract?: () => void;
  label?: string;
  /**
   * What auto mode decides for — the launch prompt and where it will run.
   * Without a target it still decides, from the benchmarks and `automode.md`.
   */
  autoTarget?: AutoSelectTarget;
  /**
   * The launching dialog's {@link AutoRegistry} (from `useAutoSubmit`). Auto
   * is offered only with one, since the pick is made when the dialog submits.
   */
  autoRegistry?: AutoRegistry;
  /**
   * Whether picking Auto here should become the default for every picker.
   * Pickers that must diverge (fanout rows) opt out.
   */
  rememberAuto?: boolean;
}

const NO_TARGET: AutoSelectTarget = { prompt: "" };

/**
 * Nested agent → searchable model → reasoning selector shared by launch
 * dialogs, with an optional **Auto** row on top that lets the configured
 * System 1 model pick all three for the prompt when the dialog submits.
 */
export function AgentModelSelector({
  agents,
  modelsByAgent,
  value,
  onChange,
  onLoadModels,
  onInteract,
  label = "Agent",
  autoTarget = NO_TARGET,
  autoRegistry,
  rememberAuto = true,
}: AgentModelSelectorProps) {
  const auto = useAutoMode({
    agents,
    modelsByAgent,
    onChange,
    onLoadModels,
    autoTarget,
    autoRegistry,
    rememberAuto,
  });
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
          <TriggerLabel
            agent={selectedAgent}
            auto={auto.enabled}
            modelLabel={modelSelectionLabel(selectedModels, value.selection)}
          />
        </Button>
      }
    >
      {auto.available === null ? null : (
        <>
          <AutoItem available={auto.available} selected={auto.enabled} onSelect={auto.enable} />
          <DropdownMenuSeparator />
        </>
      )}
      <AgentList
        agents={agents}
        modelsByAgent={modelsByAgent}
        selectedAgentId={auto.enabled ? null : value.agentId}
        selection={value.selection}
        onChange={auto.pickManually}
        onLoadModels={onLoadModels}
      />
    </NestedDropdown>
  );
}

/**
 * The trigger's text. On Auto it says only "Auto": the pick is made when the
 * dialog submits, so a manual pick shown here would never be what launches.
 */
function TriggerLabel({
  agent,
  auto,
  modelLabel,
}: {
  agent: AgentConfig | null;
  auto: boolean;
  modelLabel: string;
}) {
  if (auto) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Sparkles className="size-3.5 text-primary" />
        Auto
      </span>
    );
  }
  if (agent === null) {
    return <span className="text-muted-foreground">Select agent</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentIcon agent={agent} />
      <span className="truncate">{agent.name}</span>
      <span className="truncate text-muted-foreground">/ {modelLabel}</span>
    </span>
  );
}

function AgentList({
  agents,
  modelsByAgent,
  selectedAgentId,
  selection,
  onChange,
  onLoadModels,
}: {
  agents: AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  /** The agent to mark selected; `null` on Auto, where no manual pick is current. */
  selectedAgentId: string | null;
  selection: AgentModelSelection;
  onChange: (agentId: string, selection: AgentModelSelection) => void;
  onLoadModels: (agentId: string) => void;
}) {
  if (agents.length === 0) {
    return <NestedDropdownItem disabled>No agents configured</NestedDropdownItem>;
  }
  return agents.map((agent) => (
    <AgentSubmenu
      key={agent.id}
      agent={agent}
      models={modelsByAgent[agent.id]}
      selection={agent.id === selectedAgentId ? selection : null}
      onChange={onChange}
      onLoadModels={onLoadModels}
    />
  ));
}

/** Auto-mode state for one picker: on/off, and the handlers that switch it. */
function useAutoMode({
  agents,
  modelsByAgent,
  onChange,
  onLoadModels,
  autoTarget,
  autoRegistry,
  rememberAuto,
}: {
  agents: AgentConfig[];
  modelsByAgent: Record<string, AgentModel[] | undefined>;
  onChange: AgentModelSelectorProps["onChange"];
  onLoadModels: (agentId: string) => void;
  autoTarget: AutoSelectTarget;
  autoRegistry: AutoRegistry | undefined;
  rememberAuto: boolean;
}) {
  const status = useSystem1Status();
  const available = status === null || !autoRegistry ? null : status.configured;
  const [wanted, setWanted] = useState(() => rememberAuto && readAutoModePreference());
  const enabled = wanted && available === true;

  const onResolved = useCallback(
    (agentId: string, selection: AgentModelSelection) =>
      onChange(agentId, selection, { auto: true }),
    [onChange],
  );
  useAutoAgentSelection({
    enabled,
    registry: autoRegistry,
    target: autoTarget,
    agents,
    modelsByAgent,
    onLoadModels,
    onResolved,
  });

  const enable = useCallback(() => {
    setWanted(true);
    if (rememberAuto) rememberAutoModePreference(true);
  }, [rememberAuto]);
  const pickManually = useCallback(
    (agentId: string, selection: AgentModelSelection) => {
      setWanted(false);
      if (rememberAuto) rememberAutoModePreference(false);
      onChange(agentId, selection);
    },
    [onChange, rememberAuto],
  );
  return { available, enabled, enable, pickManually };
}

function AutoItem({
  available,
  selected,
  onSelect,
}: {
  available: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <NestedDropdownItem disabled={!available} selected={selected} onSelect={onSelect}>
      <Sparkles className="size-4 text-primary" />
      <span className="flex min-w-0 flex-col">
        <span>Auto</span>
        <span className="truncate text-xs text-muted-foreground">
          {available
            ? "System 1 picks the agent, model, and effort on submit"
            : "Add a System 1 model in Settings to enable"}
        </span>
      </span>
    </NestedDropdownItem>
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

/**
 * Pin toggle shown to the left of each model; pins float the model to the top.
 *
 * The button sits inside a Radix menu row — a selectable leaf or, for models
 * with reasoning, the submenu trigger — so a click here must stay a click here.
 * Radix selects a menu item on `pointerup` when its own `pointerdown` never
 * arrived (it synthesizes `currentTarget.click()`), and the submenu trigger
 * toggles on any un-prevented `click`. Stopping both pointer events keeps the
 * item from seeing the gesture at all, and `preventDefault` guards the
 * trigger's `defaultPrevented` check — the pin toggles, nothing selects, and
 * every open menu stays open through the reorder.
 */
function ModelPinButton({ agent, model }: { agent: AgentConfig; model: AgentModel }) {
  const pinned = isModelPinned(agent.id, model.id);
  return (
    <IconTooltip label={pinned ? "Unpin" : "Pin"}>
      <button
        aria-label={pinned ? `Unpin ${model.name}` : `Pin ${model.name}`}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
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
