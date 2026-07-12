import { useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import { NewWorktreeSheet } from "@/components/NewWorktreeSheet";
import { hapticImpact } from "@/lib/haptics";
import { IconSymbol } from "./IconSymbol";

/**
 * Header-right button shown on the in-project screens (project root, nested
 * worktrees, chat) that opens the New Worktree bottom sheet. It owns the sheet's
 * open state so screens just drop it into `headerRight`. It replaced the former
 * top-level/home navigation shortcut — the stack's native back button handles
 * escaping the drill-down.
 */
function NewWorktreeButton({ color }: { color: ColorValue }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityLabel="New worktree"
        accessibilityRole="button"
        className="h-9 w-9 items-center justify-center active:opacity-60"
        hitSlop={8}
        onPress={() => {
          hapticImpact();
          setOpen(true);
        }}
      >
        <IconSymbol color={color} fallback="+" name="plus" size={22} />
      </Pressable>
      <NewWorktreeSheet onOpenChange={setOpen} open={open} />
    </>
  );
}

/**
 * Stable `headerRight` renderer. Defining it at module scope (rather than an
 * inline arrow in each screen) keeps the button mounted as a real component so
 * its hooks work, while satisfying `react/no-unstable-nested-components`.
 */
export const renderNewWorktreeButton = ({ tintColor }: { tintColor?: ColorValue }) => (
  <NewWorktreeButton color={tintColor ?? "black"} />
);
