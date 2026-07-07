import { Stack } from "expo-router";

/** Stack that drives the project → worktree → agent → chat drill-down. */
export default function ProjectsStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: false,
        headerBackButtonDisplayMode: "default",
      }}
    />
  );
}
