import { Stack } from "expo-router";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IconSymbol } from "@/components/IconSymbol";
import { InboxCard } from "@/components/InboxCard";
import { Text } from "@/components/ui/text";
import { useInbox } from "@/lib/data/data-context";

/** Inbox tab: a stack of actionable, swipeable event cards. */
export default function InboxScreen() {
  const { items, resolve } = useInbox();
  const insets = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen options={{ title: "Inbox" }} />
      {items.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 bg-background p-8">
          <IconSymbol color="hsl(240 4% 46%)" fallback="✓" name="tray" size={40} />
          <Text className="text-lg font-semibold text-foreground">Inbox zero</Text>
          <Text className="text-center text-sm text-muted-foreground">
            Approvals and questions from your agents will show up here.
          </Text>
        </View>
      ) : (
        <ScrollView
          className="flex-1 bg-background"
          contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}
          contentInsetAdjustmentBehavior="automatic"
        >
          {items.map((item) => (
            <InboxCard item={item} key={item.id} onResolve={(res) => resolve(item.id, res)} />
          ))}
        </ScrollView>
      )}
    </>
  );
}
