import { Children, Fragment, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { IconSymbol } from "./IconSymbol";
import { Text } from "./ui/text";

/**
 * A grouped, rounded container of nav rows — the iOS Settings "inset grouped"
 * look. Inserts hairline separators between children automatically.
 */
export function NavGroup({
  title,
  footer,
  className,
  children,
}: {
  title?: string;
  footer?: string;
  className?: string;
  children: ReactNode;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View className={cn("gap-2", className)}>
      {title ? (
        <Text className="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View className="ml-4 h-px bg-border" /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? <Text className="px-4 text-xs text-muted-foreground">{footer}</Text> : null}
    </View>
  );
}

export interface NavRowProps {
  title: string;
  subtitle?: string;
  /** Leading accessory (e.g. a monogram or icon). */
  leading?: ReactNode;
  /** Trailing accessory shown left of the chevron (e.g. a status dot). */
  trailing?: ReactNode;
  /** Show the disclosure chevron (default true when onPress is set). */
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}

/** A leading/trailing accessory slot — renders nothing when empty. */
function Accessory({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <View className="shrink-0">{children}</View>;
}

/** The row's stacked title + optional subtitle. */
function RowLabel({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View className="min-w-0 flex-1">
      <Text className="text-base text-foreground" numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** The trailing disclosure chevron, when the row shows one. */
function RowChevron({ show }: { show: boolean }) {
  const colors = useThemeColors();
  if (!show) return null;
  return <IconSymbol color={colors.mutedForeground} fallback="›" name="chevron.right" size={16} />;
}

/** A single tappable settings-style row. Fires selection haptics on press. */
export function NavRow({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  onPress,
  onLongPress,
}: NavRowProps) {
  const showChevron = chevron ?? Boolean(onPress);
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
      disabled={!onPress}
      onLongPress={onLongPress}
      onPress={() => {
        hapticSelection();
        onPress?.();
      }}
    >
      <Accessory>{leading}</Accessory>
      <RowLabel subtitle={subtitle} title={title} />
      <Accessory>{trailing}</Accessory>
      <RowChevron show={showChevron} />
    </Pressable>
  );
}

/** A rounded monogram used as a project row's leading accessory. */
export function Monogram({ label }: { label: string }) {
  return (
    <View className="h-8 w-8 items-center justify-center rounded-lg bg-secondary">
      <Text className="text-sm font-semibold text-secondary-foreground">
        {label.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
