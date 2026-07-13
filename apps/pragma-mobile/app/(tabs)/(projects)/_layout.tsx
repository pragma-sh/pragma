import { Stack } from "expo-router";

import { useThemeColors } from "@/lib/theme";

/** Stack that drives the project → worktree → agent → chat drill-down. */
export default function ProjectsStackLayout() {
  const colors = useThemeColors();
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerLargeTitleStyle: { color: colors.foreground },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        headerTitleStyle: { color: colors.foreground },
        headerTransparent: false,
        headerBackButtonDisplayMode: "default",
      }}
    />
  );
}
