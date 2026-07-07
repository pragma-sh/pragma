import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { IconSymbol } from "@/components/IconSymbol";
import { renderNewWorktreeButton } from "@/components/NewWorktreeButton";
import { Text } from "@/components/ui/text";
import { useAgentTab } from "@/lib/data/data-context";

/** Placeholder chat surface for an agent tab. Real transcript wiring is TODO. */
export default function ChatScreen() {
  const { tabId } = useLocalSearchParams<{ tabId: string }>();
  const tab = useAgentTab(tabId);

  return (
    <>
      <Stack.Screen
        options={{
          title: tab?.title ?? "Chat",
          headerRight: renderNewWorktreeButton,
        }}
      />
      <View className="flex-1 items-center justify-center gap-3 bg-background p-8">
        <IconSymbol color="hsl(240 4% 46%)" fallback="◆" name="message.fill" size={40} />
        <Text className="text-lg font-semibold text-foreground">Chat view</Text>
        {tab ? (
          <View className="flex-row items-center gap-2">
            <Text className="text-sm text-muted-foreground">
              {tab.agent} · {tab.status}
            </Text>
            <AgentStatusDot status={tab.status} />
          </View>
        ) : null}
        <Text className="text-center text-sm text-muted-foreground">
          Placeholder — the agent transcript will render here once the app server is wired in.
        </Text>
      </View>
    </>
  );
}
