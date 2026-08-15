import { Stack } from "expo-router";

/** Settings owns its large title, like Inbox: native tabs suppress nested stack titles. */
export default function SettingsStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
