import { Pressable, type ColorValue } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";

/** Worktree header action for opening the launch-agent sheet. */
export function LaunchAgentButton({ color, onPress }: { color: ColorValue; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Launch agent"
      accessibilityRole="button"
      className="h-9 w-9 items-center justify-center active:opacity-60"
      hitSlop={8}
      onPress={onPress}
    >
      <IconSymbol color={color} fallback="+" name="plus" size={22} />
    </Pressable>
  );
}
