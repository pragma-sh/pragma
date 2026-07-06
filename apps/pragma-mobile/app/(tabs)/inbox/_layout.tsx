import { Stack } from "expo-router";

/** Gives the Inbox tab a native large-title header. */
export default function InboxStackLayout() {
  return <Stack screenOptions={{ headerLargeTitle: true }} />;
}
