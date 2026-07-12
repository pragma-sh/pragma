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
      <ComposerInput
        onChangeText={setText}
        placeholderTextColor={colors.mutedForeground}
        value={text}
      />
      <ComposerAction
        canSend={canSend}
        colors={colors}
        isRunning={isRunning}
        onInterrupt={onInterrupt}
        onSend={submit}
      />
    </View>
  );
}

function ComposerInput({
  onChangeText,
  placeholderTextColor,
  value,
}: {
  onChangeText: (text: string) => void;
  placeholderTextColor: string;
  value: string;
}) {
  return (
    <View className="min-h-11 flex-1 rounded-2xl border border-input bg-background px-3">
      <TextInput
        className="max-h-28 flex-1 py-2 text-base text-foreground"
        multiline
        onChangeText={onChangeText}
        placeholder="Message the agent…"
        placeholderTextColor={placeholderTextColor}
        style={{ textAlignVertical: "center" }}
        value={value}
      />
    </View>
  );
}

function ComposerAction({
  canSend,
  colors,
  isRunning,
  onInterrupt,
  onSend,
}: {
  canSend: boolean;
  colors: ReturnType<typeof useThemeColors>;
  isRunning: boolean;
  onInterrupt: () => void;
  onSend: () => void;
}) {
  if (isRunning && !canSend) return <StopAction colors={colors} onInterrupt={onInterrupt} />;
  return <SendAction canSend={canSend} colors={colors} onSend={onSend} />;
}

function StopAction({
  colors,
  onInterrupt,
}: {
  colors: ReturnType<typeof useThemeColors>;
  onInterrupt: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel="Stop the agent"
      className="h-11 w-11 items-center justify-center rounded-full bg-primary active:opacity-80"
      onPress={onInterrupt}
    >
      <IconSymbol
        color={colors.primaryForeground}
        fallback="◼"
        name="stop.fill"
        size={18}
        tintColor={colors.primaryForeground}
      />
    </Pressable>
  );
}

function SendAction({
  canSend,
  colors,
  onSend,
}: {
  canSend: boolean;
  colors: ReturnType<typeof useThemeColors>;
  onSend: () => void;
}) {
  const color = canSend ? colors.primaryForeground : colors.mutedForeground;
  return (
    <Pressable
      accessibilityLabel="Send message"
      className={`h-11 w-11 items-center justify-center rounded-full ${canSend ? "bg-primary active:opacity-80" : "bg-muted"}`}
      disabled={!canSend}
      onPress={onSend}
    >
      <IconSymbol color={color} fallback="↑" name="arrow.up" size={18} tintColor={color} />
    </Pressable>
  );
}

/** Keyboard vertical offset that clears the native header per platform. */
export const composerKeyboardOffset = Platform.OS === "ios" ? 96 : 0;
