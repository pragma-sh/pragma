import type { ScratchpadFile } from "@pragma/sdk";
import { router } from "expo-router";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { Text } from "@/components/ui/text";
import { hapticSelection } from "@/lib/haptics";
import { scratchpadsForAgentTab } from "@/lib/scratchpad-agent";
import { useThemeColors } from "@/lib/theme";
import { useScratchpads } from "@/lib/use-scratchpads";

/**
 * The scratchpad this chat's agent is attached to, as a tappable pill sitting
 * directly above the composer.
 *
 * It renders nothing when the agent has no scratchpad, so a plain chat keeps
 * its full height. Living inside the chat's `KeyboardAvoidingView` is what
 * keeps it clear of the keyboard — do not lift it out of that subtree.
 */
export function ScratchpadPill({ tabId, worktreeId }: { tabId: string; worktreeId: string }) {
  const { scratchpads } = useScratchpads(worktreeId);
  const attached = useMemo(() => scratchpadsForAgentTab(tabId, scratchpads), [scratchpads, tabId]);
  const scratchpad = attached[0];
  if (!scratchpad) return null;
  return (
    <View className="items-center px-3 pb-2">
      <PillButton extra={attached.length - 1} scratchpad={scratchpad} worktreeId={worktreeId} />
    </View>
  );
}

function PillButton({
  extra,
  scratchpad,
  worktreeId,
}: {
  extra: number;
  scratchpad: ScratchpadFile;
  worktreeId: string;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityLabel={`Open scratchpad ${scratchpad.title}`}
      accessibilityRole="button"
      className="max-w-full flex-row items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 active:opacity-80"
      onPress={() => {
        hapticSelection();
        router.push({
          pathname: "/scratchpad/[scratchpadId]",
          params: {
            scratchpadId: scratchpad.id,
            filePath: scratchpad.filePath,
            title: scratchpad.title,
            worktreeId,
          },
        });
      }}
    >
      <IconSymbol color={colors.mutedForeground} fallback="📝" name="doc.text" size={14} />
      <Text className="shrink text-sm text-foreground" numberOfLines={1}>
        {pillLabel(scratchpad.title, extra)}
      </Text>
      <IconSymbol color={colors.mutedForeground} fallback="›" name="chevron.right" size={12} />
    </Pressable>
  );
}

/** Names the scratchpad, counting the others attached to the same agent. */
function pillLabel(title: string, extra: number): string {
  return extra > 0 ? `${title} +${extra}` : title;
}
