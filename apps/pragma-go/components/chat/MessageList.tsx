import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import type { ChatConnectionState, TranscriptRow } from "@/lib/types";
import { MessageRow } from "./MessageRow";

interface MessageListProps {
  rows: TranscriptRow[];
  phase: ChatConnectionState;
}

/**
 * Chronological transcript list. Keeping the native scroll direction avoids inverted
 * FlatList's transformed content bounds, which can prevent reaching the first row.
 * Empty/connecting/error states render a centered placeholder.
 */
export function MessageList({ rows, phase }: MessageListProps) {
  const insets = useSafeAreaInsets();
  if (rows.length === 0) {
    return <Placeholder phase={phase} />;
  }

  return (
    <FlatList
      className="flex-1"
      // Leave enough trailing space to scroll the final response completely above
      // the fixed composer and device home indicator.
      contentContainerStyle={{ paddingTop: 12, paddingBottom: 72 + insets.bottom }}
      data={rows}
      keyExtractor={rowKey}
      keyboardDismissMode="interactive"
      renderItem={({ item }) => <MessageRow row={item} />}
    />
  );
}

function rowKey(row: TranscriptRow): string {
  return row.id;
}

function Placeholder({ phase }: { phase: ChatConnectionState }) {
  const message =
    phase === "error"
      ? "Lost connection — retrying…"
      : phase === "connecting"
        ? "Connecting to the agent…"
        : "No messages yet. Say something to get started.";
  return (
    <View className="flex-1 items-center justify-center p-8">
      <Text className="text-center text-sm text-muted-foreground">{message}</Text>
    </View>
  );
}
