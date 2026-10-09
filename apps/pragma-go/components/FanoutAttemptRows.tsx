import { Pressable, View } from "react-native";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentModelSelector } from "@/components/AgentModelSelector";
import { IconSymbol } from "@/components/IconSymbol";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import type { catalogToSelectorAgents } from "@/lib/catalog";
import type { AgentModelSelection } from "@/lib/data/agents";
import { MIN_FANOUT_ATTEMPTS, newAttempt, type FanoutAttempt } from "@/lib/fanout-form";
import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import type { useCatalog } from "@/lib/use-catalog";

/** How many attempts a phone offers; the host bounds concurrency regardless. */
const MAX_FANOUT_ATTEMPTS = 6;

/**
 * The fanout's attempt rows: one agent/model/effort picker per attempt, each
 * removable down to the host's floor, plus a row that adds another.
 *
 * Rows reuse the single-launch picker on purpose — choosing an agent for an
 * attempt is the same decision as choosing one for a session.
 */
export function FanoutAttemptRows({
  agents,
  attempts,
  catalog,
  onChange,
}: {
  agents: ReturnType<typeof catalogToSelectorAgents>;
  attempts: FanoutAttempt[];
  catalog: ReturnType<typeof useCatalog>;
  onChange: (attempts: FanoutAttempt[]) => void;
}) {
  const colors = useThemeColors();
  const removable = attempts.length > MIN_FANOUT_ATTEMPTS;

  const update = (key: string, selection: AgentModelSelection): void =>
    onChange(
      attempts.map((attempt) => (attempt.key === key ? { ...attempt, selection } : attempt)),
    );

  return (
    <View className="gap-3">
      {attempts.map((attempt, index) => (
        <View key={attempt.key} className="flex-row items-center gap-2">
          <Text className="w-5 text-sm text-muted-foreground">{index + 1}</Text>
          <AgentIcon
            fallback="◆"
            icon={catalog?.agents.find((agent) => agent.id === attempt.selection?.agentId)?.icon}
            size={22}
          />
          <View className="flex-1">
            <AgentModelSelector
              agents={agents}
              onChange={(selection) => update(attempt.key, selection)}
              value={attempt.selection}
            />
          </View>
          {removable ? (
            <Pressable
              accessibilityLabel={`Remove attempt ${index + 1}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                hapticSelection();
                onChange(attempts.filter((candidate) => candidate.key !== attempt.key));
              }}
            >
              <IconSymbol
                color={colors.mutedForeground}
                fallback="✕"
                name="minus.circle"
                size={20}
              />
            </Pressable>
          ) : null}
        </View>
      ))}
      {attempts.length < MAX_FANOUT_ATTEMPTS ? (
        <Button
          onPress={() => {
            hapticSelection();
            onChange([...attempts, newAttempt(attempts.at(-1)?.selection ?? null)]);
          }}
          size="sm"
          variant="outline"
        >
          <Text>Add attempt</Text>
        </Button>
      ) : null}
    </View>
  );
}
