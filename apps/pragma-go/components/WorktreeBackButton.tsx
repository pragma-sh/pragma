import { router } from "expo-router";
import { Pressable, type ColorValue } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { Text } from "@/components/ui/text";
import { useWorktree } from "@/lib/data/data-context";
import { worktreeLabel } from "@/lib/worktree-tree";

/**
 * Header back control for root-stack screens pushed from a worktree.
 *
 * Expo Router would otherwise label the previous root route `(tabs)`; this
 * shows the worktree being returned to instead — or `label`, when the screen
 * was opened from somewhere other than the worktree (a fanout says "Fanout").
 */
export function WorktreeBackButton({
  color,
  label: override,
  worktreeId,
}: {
  color: ColorValue;
  /** Replaces the worktree's name, for a screen pushed from elsewhere. */
  label?: string;
  worktreeId: string;
}) {
  const worktree = useWorktree(worktreeId);
  const label = override || (worktree ? worktreeLabel(worktree) : "Back");
  return (
    <Pressable
      accessibilityLabel={`Back to ${label}`}
      accessibilityRole="button"
      className="h-9 flex-row items-center active:opacity-60"
      hitSlop={8}
      onPress={() => router.back()}
    >
      <IconSymbol color={color} fallback="‹" name="chevron.left" size={22} />
      <Text className="text-base" numberOfLines={1} style={{ color }}>
        {label}
      </Text>
    </Pressable>
  );
}
