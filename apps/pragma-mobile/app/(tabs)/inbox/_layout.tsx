import { Stack } from "expo-router";

/** Inbox owns its large title because iOS native tabs suppress nested stack titles. */
export default function InboxStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
