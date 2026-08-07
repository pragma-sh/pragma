import { View } from "react-native";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { NavRow } from "@/components/NavRow";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import type { AgentTab } from "@/lib/types";
import { useCatalogAgent } from "@/lib/use-catalog";

export interface AttachAgentDrawerProps {
  open: boolean;
  /** Agent tabs in this scratchpad's worktree. */
  agentTabs: AgentTab[];
  /** The tab the scratchpad currently prompts, if any. */
  attachedTabId: string | null;
  onAttach: (tab: AgentTab) => void;
  onClose: () => void;
}

/**
 * Picks which agent the scratchpad talks to.
 *
 * A scratchpad prompts exactly one agent tab, recorded in its frontmatter, so
 * this drawer both opens on demand and is raised automatically when something
 * needs an agent and none is attached.
 */
export function AttachAgentDrawer({
  open,
  agentTabs,
  attachedTabId,
  onAttach,
  onClose,
}: AttachAgentDrawerProps) {
  return (
    <BottomSheet onOpenChange={(next) => !next && onClose()} open={open}>
      <Text className="text-lg font-semibold text-foreground">Attach an agent</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        Comments and interactive blocks in this scratchpad are sent to the agent you pick.
      </Text>
      <View className="mt-4 gap-2">
        {agentTabs.length === 0 ? (
          <Text className="py-4 text-muted-foreground">
            No agents are running in this worktree. Launch one first.
          </Text>
        ) : (
          agentTabs.map((tab) => (
            <AgentChoiceRow
              attached={tab.id === attachedTabId}
              key={tab.id}
              onAttach={onAttach}
              tab={tab}
            />
          ))
        )}
      </View>
      <Button className="mt-4" onPress={onClose} variant="secondary">
        <Text>Cancel</Text>
      </Button>
    </BottomSheet>
  );
}

/** One choosable agent tab, with the icon its plugin contributed. */
function AgentChoiceRow({
  attached,
  onAttach,
  tab,
}: {
  attached: boolean;
  onAttach: (tab: AgentTab) => void;
  tab: AgentTab;
}) {
  const catalogAgent = useCatalogAgent(tab.agent);
  return (
    <NavRow
      chevron={false}
      leading={<AgentIcon fallback="●" icon={catalogAgent?.icon} size={24} />}
      onPress={() => onAttach(tab)}
      subtitle={attached ? `${tab.agent} · attached` : tab.agent}
      title={tab.title}
      trailing={<AgentStatusDot status={tab.status} />}
    />
  );
}
