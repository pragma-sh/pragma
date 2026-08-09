import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** Left padding added per level of nesting, in points. */
const INDENT_STEP = 12;

interface SidebarRowProps {
  title: string;
  /** Leading icon slot. */
  icon?: ReactNode;
  /** Trailing accessory, typically a status dot. */
  trailing?: ReactNode;
  /** Count rendered as a pill on the right (Inbox). */
  badge?: string;
  /** Nesting level; indents the row. */
  depth?: number;
  /** Whether this row is the current route. */
  selected?: boolean;
  /** `section` renders a project header: smaller, uppercase, no icon slot. */
  variant?: "row" | "section";
  onPress: () => void;
}

/**
 * One row in the wide-layout sidebar.
 *
 * Deliberately not `NavRow`: that is the phone's grouped-list row, complete
 * with a disclosure chevron implying a push onto a stack. A sidebar row selects
 * something that stays in view beside it, so it reads as a persistent selection
 * instead.
 */
export function SidebarRow({
  title,
  icon,
  trailing,
  badge,
  depth = 0,
  selected = false,
  variant = "row",
  onPress,
}: SidebarRowProps) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ selected }}
      className={cn(
        "flex-row items-center gap-2 rounded-md py-1.5 pr-2",
        selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
      )}
      onPress={() => {
        hapticSelection();
        onPress();
      }}
      style={{ paddingLeft: 8 + depth * INDENT_STEP }}
    >
      {icon ? <View className="w-4 items-center">{icon}</View> : null}
      <Text className={titleClass(variant, selected)} numberOfLines={1}>
        {title}
      </Text>
      {badge ? <Badge value={badge} /> : null}
      {trailing}
    </Pressable>
  );
}

/** Type treatment for the label: a project header, a selected row, or a row. */
function titleClass(variant: "row" | "section", selected: boolean): string {
  if (variant === "section") {
    return "flex-1 text-xs font-medium uppercase tracking-wide text-sidebar-foreground";
  }
  return cn(
    "flex-1 text-sm",
    selected ? "font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground",
  );
}

/** Count pill, used for the Inbox's unresolved items. */
function Badge({ value }: { value: string }) {
  return (
    <View className="rounded-full bg-destructive px-1.5">
      <Text className="text-xs text-destructive-foreground">{value}</Text>
    </View>
  );
}
