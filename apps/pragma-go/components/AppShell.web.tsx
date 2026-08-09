import { usePathname } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppSidebar } from "@/components/AppSidebar";
import { routeNeedsSidebar } from "@/lib/sidebar-visibility";
import { useWideLayout } from "@/lib/use-wide-layout";

/** Web shell adds worktree navigation only where page content has no picker. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const showSidebar = useWideLayout() && routeNeedsSidebar(pathname);

  return (
    <View className="flex-1 flex-row bg-background">
      {showSidebar ? <AppSidebar /> : null}
      <View className="min-w-0 flex-1">{children}</View>
    </View>
  );
}
