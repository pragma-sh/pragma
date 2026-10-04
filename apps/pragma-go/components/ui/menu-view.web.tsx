import type { MenuAction } from "@react-native-menu/menu";
import { useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";

import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type { MenuAction };

interface MenuViewProps {
  actions: MenuAction[];
  onPressAction: (event: { nativeEvent: { event: string } }) => void;
  style?: StyleProp<ViewStyle>;
  title?: string;
  children: ReactNode;
}

/**
 * Web counterpart of the native pull-down menu.
 *
 * A browser has no system menu, so this is a popover with the same contract:
 * the same `actions` tree in, the same `{ nativeEvent: { event } }` out. Nested
 * `subactions` are flattened into labelled groups rather than a second-level
 * menu — with a pointer there is no reason to make the user open two menus, and
 * the whole tree fits on screen.
 */
export function MenuView({ actions, onPressAction, style, title, children }: MenuViewProps) {
  const [open, setOpen] = useState(false);

  const choose = (id: string): void => {
    setOpen(false);
    onPressAction({ nativeEvent: { event: id } });
  };

  return (
    <View style={style}>
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)}>
        {children}
      </Pressable>
      {open ? (
        <>
          {/* A full-screen catcher so a click anywhere else dismisses the menu,
              which is what the native menu does and what a pointer user expects. */}
          {/* `position: "fixed"` is CSS-only; React Native Web understands it,
              React Native's style types do not. */}
          <Pressable
            onPress={() => setOpen(false)}
            style={
              { bottom: 0, left: 0, position: "fixed", right: 0, top: 0 } as unknown as ViewStyle
            }
          />
          <View className="absolute left-0 right-0 top-12 z-50 rounded-lg border border-border bg-popover py-1 shadow-lg">
            {title ? (
              <Text className="px-3 py-1.5 text-xs text-muted-foreground">{title}</Text>
            ) : null}
            {actions.map((action) => (
              <MenuGroup action={action} key={action.id ?? action.title} onChoose={choose} />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

/** One action: a leaf row, or a labelled group when it carries subactions. */
function MenuGroup({ action, onChoose }: { action: MenuAction; onChoose: (id: string) => void }) {
  const subactions = action.subactions ?? [];
  if (subactions.length === 0) {
    return <MenuRow action={action} onChoose={onChoose} />;
  }
  return (
    <View>
      <Text className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        {action.title}
      </Text>
      {subactions.map((sub) => (
        <MenuRow action={sub} key={sub.id ?? sub.title} onChoose={onChoose} />
      ))}
    </View>
  );
}

/**
 * A selectable row, check-marked when the action reports itself as on. A
 * disabled action stays visible but inert, as it does in the native menu, and
 * its subtitle carries the reason.
 */
function MenuRow({ action, onChoose }: { action: MenuAction; onChoose: (id: string) => void }) {
  const id = action.id;
  const disabled = isDisabled(action);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ disabled, selected: action.state === "on" }}
      className={cn(
        "flex-row items-center justify-between gap-3 px-3 py-2",
        disabled ? "opacity-50" : "hover:bg-accent",
      )}
      disabled={disabled}
      onPress={() => id && onChoose(id)}
    >
      <MenuRowLabel action={action} />
      {action.state === "on" ? <Text className="text-sm text-foreground">✓</Text> : null}
    </Pressable>
  );
}

/** An action with no id has nothing to report back, so it is inert too. */
function isDisabled(action: MenuAction): boolean {
  return !action.id || action.attributes?.disabled === true;
}

/** The row's title, with the subtitle (often a disabled row's reason) beneath. */
function MenuRowLabel({ action }: { action: MenuAction }) {
  return (
    <View className="flex-1">
      <Text className="text-sm text-foreground">{action.title}</Text>
      {action.subtitle ? (
        <Text className="text-xs text-muted-foreground">{action.subtitle}</Text>
      ) : null}
    </View>
  );
}
