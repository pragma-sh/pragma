import { View } from "react-native";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { toAgentView, type AgentView } from "@/lib/agent-view";
import { hapticSelection } from "@/lib/haptics";

/**
 * Switches one agent session between its chat surface and its raw TUI.
 *
 * Both views are the same host session, so this is a view switch and never a
 * navigation: pushing a second screen would leave the agent reachable from two
 * places in the back stack, and detach the renderer every time the user looked
 * at the transcript.
 */
export function AgentViewTabs({
  onValueChange,
  value,
}: {
  onValueChange: (view: AgentView) => void;
  value: AgentView;
}) {
  return (
    <View className="px-4 py-2">
      <Tabs
        onValueChange={(next) => {
          const view = toAgentView(next);
          if (view !== value) hapticSelection();
          onValueChange(view);
        }}
        value={value}
      >
        <TabsList className="w-full">
          <TabsTrigger value="chat">
            <Text>Chat</Text>
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <Text>Terminal</Text>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </View>
  );
}
