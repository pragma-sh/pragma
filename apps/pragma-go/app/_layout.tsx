import "../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { Redirect, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConnectionProvider, useConnection } from "@/lib/connection-context";
import { DataProvider } from "@/lib/data/data-context";
import { FanoutsProvider } from "@/lib/fanouts-context";
import { ThemeProvider } from "@/lib/theme-context";
import { usePushNotifications } from "@/lib/use-push-notifications";
import { useThemeColors } from "@/lib/theme";
import { useWidgetSync } from "@/lib/widgets/use-widget-sync";

/**
 * Root layout: global providers, tab navigator, and the full-screen chat and
 * scratchpad screens. Native headers and the
 * NativeWind theme both follow the system light/dark scheme automatically
 * (`userInterfaceStyle: "automatic"` in app.json), and ThemeProvider layers the
 * paired desktop's `.pragma/theme.json` colors over them. ConnectionProvider
 * owns the single app-wide PragmaClient. Until that client is verified, pairing replaces
 * the app rather than appearing over navigable sample data.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ConnectionProvider>
          <ThemeProvider>
            <DataProvider>
              <FanoutsProvider>
                <StatusBar style="auto" />
                <WidgetSync />
                <ConnectionGate />
              </FanoutsProvider>
            </DataProvider>
          </ThemeProvider>
        </ConnectionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Keeps the iOS home-screen widgets in step with the live workspace. */
function WidgetSync() {
  useWidgetSync();
  return null;
}

/** Renders pairing as the whole app until the host connection is verified. */
function ConnectionGate() {
  const { status } = useConnection();
  const colors = useThemeColors();
  usePushNotifications();

  if (status === "loading") return null;

  if (status === "unpaired") {
    return (
      <>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="pair" />
        </Stack>
        <Redirect href="/pair" />
      </>
    );
  }

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
          headerTitleStyle: { color: colors.foreground },
          // React Navigation's default scene background is white regardless of
          // the app's theme, so a push flashes white before the screen paints.
          // Every route in this stack is themed, so the scene behind it is too.
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
        {/* `headerBackTitle` is explicit on every full-screen route: the tab
            navigator underneath has no header of its own, so iOS falls back to
            the route's own name and labels the back button "(tabs)". */}
        <Stack.Screen
          name="chat/[tabId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="scratchpad/[scratchpadId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="terminal/[tabId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="fanout/[fanoutId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="file/[worktreeId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
        <Stack.Screen
          name="diff/[worktreeId]"
          options={{ headerShown: true, headerBackTitle: "Back" }}
        />
      </Stack>
      <PortalHost />
    </>
  );
}
