import { NativeTabs } from "expo-router/unstable-native-tabs";

import { useInbox } from "@/lib/data/data-context";

/**
 * The two primary surfaces as native bottom tabs. On iOS 26 these render with
 * the system liquid-glass tab bar automatically; on Android they use the native
 * Material tab bar.
 *
 * `sidebarAdaptable` promotes the same tabs to the system sidebar on iPadOS,
 * which is where the liquid-glass sidebar comes from — no custom column needed.
 * It has no effect on iPhone, and none on Android, whose wide layout is handled
 * by the shared sidebar in the web/tablet shell.
 */
export default function TabsLayout() {
  const { items } = useInbox();
  const inboxCount = items.length;

  return (
    <NativeTabs sidebarAdaptable>
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
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon drawable="ic_menu_preferences" sf="gearshape.fill" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
