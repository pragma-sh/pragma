import "../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { Redirect, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConnectionProvider, useConnection } from "@/lib/connection-context";
import { DataProvider } from "@/lib/data/data-context";
import { useThemeColors } from "@/lib/theme";
import { useWidgetSync } from "@/lib/widgets/use-widget-sync";

/**
 * Root layout: global providers, tab navigator, and full-screen chat. Native headers and the
 * NativeWind theme both follow the system light/dark scheme automatically
 * (`userInterfaceStyle: "automatic"` in app.json). ConnectionProvider owns the
 * single app-wide PragmaClient. Until that client is verified, pairing replaces
 * the app rather than appearing over navigable sample data.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ConnectionProvider>
          <DataProvider>
            <StatusBar style="auto" />
            <WidgetSync />
            <ConnectionGate />
          </DataProvider>
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
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[tabId]" options={{ headerShown: true }} />
      </Stack>
      <PortalHost />
    </>
  );
}
