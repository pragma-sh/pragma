import { NativeTabs } from "expo-router/unstable-native-tabs";

import { useInbox } from "@/lib/data/data-context";

/**
 * The two primary surfaces as native bottom tabs. On iOS 26 these render with
 * the system liquid-glass tab bar automatically; on Android they use the native
 * Material tab bar.
 */
export default function TabsLayout() {
  const { items } = useInbox();
  const inboxCount = items.length;

  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(projects)">
        <NativeTabs.Trigger.Icon drawable="ic_menu_agenda" sf="folder.fill" />
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon drawable="ic_menu_sort_by_size" sf="tray.full.fill" />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        {inboxCount > 0 ? (
          <NativeTabs.Trigger.Badge>{String(inboxCount)}</NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
