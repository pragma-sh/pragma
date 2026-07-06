import { Children, Fragment, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { hapticSelection } from "@/lib/haptics";
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
}

/** A single tappable settings-style row. Fires selection haptics on press. */
export function NavRow({ title, subtitle, leading, trailing, chevron, onPress }: NavRowProps) {
  const showChevron = chevron ?? Boolean(onPress);
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
      disabled={!onPress}
      onPress={() => {
        hapticSelection();
        onPress?.();
      }}
    >
      {leading ? <View className="shrink-0">{leading}</View> : null}
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
      {trailing ? <View className="shrink-0">{trailing}</View> : null}
      {showChevron ? (
        <IconSymbol color="hsl(240 4% 46%)" fallback="›" name="chevron.right" size={16} />
      ) : null}
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
