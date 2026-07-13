import { type MenuAction, MenuView } from "@react-native-menu/menu";
import { View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { Text } from "@/components/ui/text";
import {
  agentSelectionLabel,
  MOCK_AGENTS,
  type AgentModelSelection,
  type MockAgent,
} from "@/lib/data/agents";
import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";

interface AgentModelSelectorProps {
  agents?: MockAgent[];
  value: AgentModelSelection | null;
  onChange: (selection: AgentModelSelection) => void;
}

/** Separator that can't appear in agent/model/reasoning ids (all kebab-case). */
const SEP = "|";

/** Encode an agent/model selection into a native-menu action id. */
function modelId(agentId: string, selectedModelId: string): string {
  return [agentId, selectedModelId].join(SEP);
}

/** Decode a model action id back into a selection, or null for parent actions. */
function parseModelId(id: string): AgentModelSelection | null {
  const parts = id.split(SEP);
  if (parts.length !== 2) return null;
  const [agentId, selectedModelId] = parts as [string, string];
  return { agentId, modelId: selectedModelId, reasoningId: null };
}

/**
 * Mobile adaptation of the desktop agent → model → reasoning dropdown. The field
 * opens a **native** pull-down menu (`MenuView`) with agent submenus and model
 * leaves. Selecting a reasoning-capable model reveals a separate effort menu.
 * This keeps native nesting to one level, which Android supports, and avoids a
 * third-level iOS menu competing with the containing bottom-sheet modal.
 */
export function AgentModelSelector({
  agents = MOCK_AGENTS,
  value,
  onChange,
}: AgentModelSelectorProps) {
  const label = value ? agentSelectionLabel(value, agents) : null;
  const actions = buildActions(agents, value);
  const colors = useThemeColors();

  const onSelectModel = ({ nativeEvent }: { nativeEvent: { event: string } }) => {
    const selection = parseModelId(nativeEvent.event);
    if (!selection) return;
    hapticSelection();
    onChange(selection);
  };

  return (
    <View className="flex-row gap-2">
      <AgentMenu actions={actions} colors={colors} label={label} onSelect={onSelectModel} />
      <EffortMenu colors={colors} label={label} onChange={onChange} value={value} />
    </View>
  );
}

function AgentMenu({
  actions,
  colors,
  label,
  onSelect,
}: {
  actions: MenuAction[];
  colors: ReturnType<typeof useThemeColors>;
  label: ReturnType<typeof agentSelectionLabel>;
  onSelect: (event: { nativeEvent: { event: string } }) => void;
}) {
  return (
    <MenuView
      actions={actions}
      onPressAction={onSelect}
      style={{ flex: 1 }}
      title="Choose agent and model"
    >
      <View className="h-11 flex-row items-center justify-between rounded-lg border border-input bg-background px-3">
        {label ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {label.agent.name}
            </Text>
            <Text className="min-w-0 flex-1 text-base text-muted-foreground" numberOfLines={1}>
              / {label.model.name}
            </Text>
          </View>
        ) : (
          <Text className="text-base text-muted-foreground">Select agent</Text>
        )}
        <SelectorIcon color={colors.mutedForeground} />
      </View>
    </MenuView>
  );
}

function EffortMenu({
  colors,
  label,
  onChange,
  value,
}: {
  colors: ReturnType<typeof useThemeColors>;
  label: ReturnType<typeof agentSelectionLabel>;
  onChange: (selection: AgentModelSelection) => void;
  value: AgentModelSelection | null;
}) {
  if (!label) return null;
  if (label.model.reasoning.length === 0) return null;
  return (
    <MenuView
      actions={effortActions(label, value)}
      onPressAction={({ nativeEvent }) => selectReasoning(label, nativeEvent.event, onChange)}
      style={{ flex: 1 }}
      title="Choose effort"
    >
      <View className="h-11 flex-row items-center justify-between rounded-lg border border-input bg-background px-3">
        <Text className="text-base text-foreground">Effort</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-base text-muted-foreground">{effortLabel(label)}</Text>
          <SelectorIcon color={colors.mutedForeground} />
        </View>
      </View>
    </MenuView>
  );
}

function effortLabel(label: NonNullable<ReturnType<typeof agentSelectionLabel>>): string {
  return label.reasoning?.name ?? "Auto";
}

function effortActions(
  label: NonNullable<ReturnType<typeof agentSelectionLabel>>,
  value: AgentModelSelection | null,
): MenuAction[] {
  return [
    { id: "auto", title: "Auto", state: menuState(value?.reasoningId === null) },
    ...label.model.reasoning.map((reasoning) => ({
      id: reasoning.id,
      title: reasoning.name,
      state: menuState(value?.reasoningId === reasoning.id),
    })),
  ];
}

function menuState(selected: boolean): "on" | "off" {
  return selected ? "on" : "off";
}

function SelectorIcon({ color }: { color: string }) {
  return <IconSymbol color={color} fallback="⌄" name="chevron.up.chevron.down" size={16} />;
}

function selectReasoning(
  label: NonNullable<ReturnType<typeof agentSelectionLabel>>,
  reasoningId: string,
  onChange: (selection: AgentModelSelection) => void,
): void {
  hapticSelection();
  onChange({
    agentId: label.agent.id,
    modelId: label.model.id,
    reasoningId: reasoningId === "auto" ? null : reasoningId,
  });
}

/** Build the nested native-menu action tree from the agent fixtures. */
function buildActions(agents: MockAgent[], value: AgentModelSelection | null): MenuAction[] {
  const selectedModel = value ? modelId(value.agentId, value.modelId) : null;
  return agents.map((agent) => ({
    id: agent.id,
    title: agent.name,
    subactions: agent.models.map((model) => {
      const id = modelId(agent.id, model.id);
      return { id, title: model.name, state: id === selectedModel ? "on" : "off" };
    }),
  }));
}
