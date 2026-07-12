import { useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";

interface ComposerProps {
  isRunning: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

/**
 * Message composer with one action: Send unless a running agent has no queued
 * text, in which case it becomes Stop. The parent wraps it in KeyboardAvoidingView.
 */
export function Composer({ isRunning, onSend, onInterrupt }: ComposerProps) {
  const [text, setText] = useState("");
  const colors = useThemeColors();
  const canSend = text.trim().length > 0;
  const showStop = isRunning && !canSend;

  function submit(): void {
    if (!canSend) return;
    hapticSelection();
    onSend(text);
    setText("");
  }

  return (
    <View
      className="flex-row items-end gap-2 border-t border-border bg-background px-3 pt-2"
      style={{ paddingBottom: 8 }}
    >
      <View className="min-h-11 flex-1 rounded-2xl border border-input bg-background px-3">
        <TextInput
          className="max-h-28 flex-1 py-2 text-base text-foreground"
          multiline
          onChangeText={setText}
          placeholder="Message the agent…"
          placeholderTextColor={colors.mutedForeground}
          style={{ textAlignVertical: "center" }}
          value={text}
        />
      </View>
      <Pressable
        accessibilityLabel={showStop ? "Stop the agent" : "Send message"}
        className={`h-11 w-11 items-center justify-center rounded-full ${showStop || canSend ? "bg-primary active:opacity-80" : "bg-muted"}`}
        disabled={!showStop && !canSend}
        onPress={showStop ? onInterrupt : submit}
      >
        <IconSymbol
          color={showStop || canSend ? colors.primaryForeground : colors.mutedForeground}
          fallback={showStop ? "◼" : "↑"}
          name={showStop ? "stop.fill" : "arrow.up"}
          size={18}
          tintColor={showStop || canSend ? colors.primaryForeground : colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}

/** Keyboard vertical offset that clears the native header per platform. */
export const composerKeyboardOffset = Platform.OS === "ios" ? 96 : 0;
