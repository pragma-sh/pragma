import { useColorScheme, View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import type { AgentAttentionKind } from "@/lib/types";

const DARK_FOREGROUND = "hsl(0 0% 98%)";
const LIGHT_FOREGROUND = "hsl(240 6% 10%)";

/**
 * Icon + label pill identifying a command approval or a question request.
 * Flat, theme-neutral black/gray treatment (secondary surface) so it reads
 * as a status marker rather than competing with the card's own accents.
 */
export function RequestTypeBadge({
  kind,
  className,
}: {
  kind: AgentAttentionKind;
  className?: string;
}) {
  const colorScheme = useColorScheme();
  const isCommand = kind === "command";
  const foreground = colorScheme === "dark" ? DARK_FOREGROUND : LIGHT_FOREGROUND;

  return (
    <View
      className={cn(
        "flex-row items-center gap-1 self-start rounded-full bg-secondary px-2.5 py-1",
        className,
      )}
    >
      <IconSymbol
        color={foreground}
        fallback={isCommand ? "❯_" : "?"}
        name={isCommand ? "terminal.fill" : "questionmark.circle.fill"}
        size={11}
        tintColor={foreground}
      />
      <Text className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
        {kind}
      </Text>
    </View>
  );
}
