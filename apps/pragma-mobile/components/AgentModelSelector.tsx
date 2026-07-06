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

interface AgentModelSelectorProps {
  agents?: MockAgent[];
  value: AgentModelSelection | null;
  onChange: (selection: AgentModelSelection) => void;
}

/** Separator that can't appear in an agent/model/reasoning id (all kebab-case). */
const SEP = "|";

/** Encode a leaf selection into a single native-menu action id. */
function leafId(agentId: string, modelId: string, reasoningId: string | null): string {
  return [agentId, modelId, reasoningId ?? ""].join(SEP);
}

/** Decode a leaf action id back into a selection, or null if it isn't a leaf. */
function parseLeafId(id: string): AgentModelSelection | null {
  const parts = id.split(SEP);
  if (parts.length !== 3) return null;
  const [agentId, modelId, reasoningId] = parts as [string, string, string];
  return { agentId, modelId, reasoningId: reasoningId === "" ? null : reasoningId };
}

/**
 * Mobile adaptation of the desktop agent → model → reasoning dropdown. The field
 * opens a **native** pull-down menu (`MenuView`): agents are submenus, models
 * without reasoning are leaf items, and models with reasoning levels open one
 * more native submenu. This replaces the old nested bottom-sheet picker so the
 * selector no longer stacks a drawer inside the New Worktree sheet.
 */
export function AgentModelSelector({
  agents = MOCK_AGENTS,
  value,
  onChange,
}: AgentModelSelectorProps) {
  const label = value ? agentSelectionLabel(value, agents) : null;
  const actions = buildActions(agents, value);

  return (
    <MenuView
      onPressAction={({ nativeEvent }) => {
        const selection = parseLeafId(nativeEvent.event);
        if (!selection) return;
        hapticSelection();
        onChange(selection);
      }}
      actions={actions}
      style={{ alignSelf: "stretch" }}
      title="Choose agent"
    >
      <View className="h-11 flex-row items-center justify-between rounded-lg border border-input bg-background px-3">
        {label ? (
          <View className="min-w-0 flex-1 flex-row items-center gap-2">
            <Text className="text-base">{label.agent.icon}</Text>
            <Text className="text-base text-foreground" numberOfLines={1}>
              {label.agent.name}
            </Text>
            <Text className="min-w-0 flex-1 text-base text-muted-foreground" numberOfLines={1}>
              / {label.model.name}
              {label.reasoning ? ` · ${label.reasoning.name}` : ""}
            </Text>
          </View>
        ) : (
          <Text className="text-base text-muted-foreground">Select agent</Text>
        )}
        <IconSymbol color="hsl(240 4% 46%)" fallback="⌄" name="chevron.up.chevron.down" size={16} />
      </View>
    </MenuView>
  );
}

/** Build the nested native-menu action tree from the agent fixtures. */
function buildActions(agents: MockAgent[], value: AgentModelSelection | null): MenuAction[] {
  return agents.map((agent) => ({
    id: agent.id,
    title: `${agent.icon}  ${agent.name}`,
    subactions: agent.models.map((model) => {
      if (model.reasoning.length > 0) {
        return {
          id: model.id,
          title: model.name,
          subactions: model.reasoning.map((reasoning) => ({
            id: leafId(agent.id, model.id, reasoning.id),
            title: reasoning.name,
            state:
              value?.agentId === agent.id &&
              value.modelId === model.id &&
              value.reasoningId === reasoning.id
                ? "on"
                : "off",
          })),
        } satisfies MenuAction;
      }
      return {
        id: leafId(agent.id, model.id, null),
        title: model.name,
        state:
          value?.agentId === agent.id && value.modelId === model.id && !value.reasoningId
            ? "on"
            : "off",
      } satisfies MenuAction;
    }),
  }));
}
