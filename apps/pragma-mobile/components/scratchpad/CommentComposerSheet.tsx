import type { ScratchpadBlock } from "@pragma/scratchpad-viewer";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

export interface CommentComposerSheetProps {
  /** The block the user picked, or null when the sheet is closed. */
  block: ScratchpadBlock | null;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}

/** Writes one comment against the block the reader tapped or pressed and held. */
export function CommentComposerSheet({ block, onCancel, onSubmit }: CommentComposerSheetProps) {
  const [text, setText] = useState("");

  // Each pick starts a fresh comment; keeping the last draft would silently
  // attach it to a different block.
  useEffect(() => setText(""), [block?.index]);

  return (
    <BottomSheet onOpenChange={(open) => !open && onCancel()} open={block !== null}>
      <Text className="text-lg font-semibold text-foreground">Comment</Text>
      <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={3}>
        {block?.quote || "This block has no text."}
      </Text>
      <Input
        autoFocus
        className="mt-4 h-24 py-2"
        multiline
        onChangeText={setText}
        placeholder="What should the agent change?"
        textAlignVertical="top"
        value={text}
      />
      <View className="mt-4 flex-row gap-3">
        <Button className="flex-1" onPress={onCancel} variant="secondary">
          <Text>Cancel</Text>
        </Button>
        <Button
          className="flex-1"
          disabled={text.trim().length === 0}
          onPress={() => onSubmit(text)}
        >
          <Text>Add comment</Text>
        </Button>
      </View>
    </BottomSheet>
  );
}
