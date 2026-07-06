import "../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { DataProvider } from "@/lib/data/data-context";

/**
 * Root layout: global providers + the (tabs) stack. Native headers and the
 * NativeWind theme both follow the system light/dark scheme automatically
 * (`userInterfaceStyle: "automatic"` in app.json).
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <DataProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
          <PortalHost />
        </DataProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
