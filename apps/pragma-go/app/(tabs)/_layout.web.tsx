import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { useInbox } from "@/lib/data/data-context";
import { useThemeColors } from "@/lib/theme";

// Web counterpart of `_layout.tsx`. `NativeTabs` has a web implementation, but
// it is a text-only Radix tab strip — no icons, and no sidebar at any width. So
// the browser uses the JS `Tabs` navigator. On wide screens the root AppShell
// owns contextual worktree navigation, while picker screens need no duplicate
// navigation column.

/** The primary surfaces as persistent web bottom tabs. */
export default function TabsWebLayout() {
  const { items } = useInbox();
  const colors = useThemeColors();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.foreground,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: { backgroundColor: colors.background },
        tabBarPosition: "bottom",
      }}
    >
      <Tabs.Screen
        name="(projects)"
        options={{
          title: "Projects",
          tabBarIcon: renderProjectsIcon,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarBadge: items.length > 0 ? items.length : undefined,
          tabBarIcon: renderInboxIcon,
        }}
      />
    </Tabs>
  );
}

// Module-level renderers, as elsewhere in the app: defining these inline would
// hand React a new component type on every render and remount the icons.

function renderProjectsIcon({ color }: { color: ColorValue }) {
  return <IconSymbol color={color} fallback="📁" name="folder.fill" size={22} />;
}

function renderInboxIcon({ color }: { color: ColorValue }) {
  return <IconSymbol color={color} fallback="✉" name="tray.full.fill" size={22} />;
}
