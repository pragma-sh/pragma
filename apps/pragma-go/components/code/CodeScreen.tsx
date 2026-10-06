import { Stack } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, View, type ColorValue } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { unavailableText, type CodeView } from "@/lib/code-content";
import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import { CodeWebView } from "./CodeWebView";

/**
 * The shared frame of the read-only file and diff screens: a header with the
 * file name and a wrap toggle, then the viewer — or the reason there is none.
 *
 * Wrapping defaults on: a phone is narrow, and sideways scrolling through every
 * long line is the worse default there, unlike on a desktop editor.
 */
export function CodeScreen({
  error,
  loading,
  onRetry,
  subtitle,
  title,
  view,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  subtitle?: string;
  title: string;
  /** What the read produced: content for the viewer, or why there is none. */
  view: CodeView;
}) {
  const [wrap, setWrap] = useState(true);
  const colors = useThemeColors();
  const renderWrapToggle = useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <Pressable
        accessibilityLabel={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
        accessibilityRole="button"
        accessibilityState={{ selected: wrap }}
        hitSlop={8}
        onPress={() => {
          hapticSelection();
          setWrap((value) => !value);
        }}
      >
        <Text style={{ color: tintColor ?? colors.foreground }}>{wrap ? "No wrap" : "Wrap"}</Text>
      </Pressable>
    ),
    [colors.foreground, wrap],
  );

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
      <Stack.Screen
        options={{
          title,
          headerRight: view.content ? renderWrapToggle : undefined,
        }}
      />
      {subtitle ? (
        <Text className="px-4 py-2 text-xs text-muted-foreground" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      <CodeBody error={error} loading={loading} onRetry={onRetry} view={view} wrap={wrap} />
    </SafeAreaView>
  );
}

function CodeBody({
  error,
  loading,
  onRetry,
  view,
  wrap,
}: {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  view: CodeView;
  wrap: boolean;
}) {
  if (view.unavailable) return <Notice text={unavailableText(view.unavailable)} />;
  if (view.content) return <CodeWebView content={view.content} wrap={wrap} />;
  if (error) return <ReadError message={error} onRetry={onRetry} />;
  return <Pending loading={loading} />;
}

/** The empty frame while a read is still in flight. */
function Pending({ loading }: { loading: boolean }) {
  if (!loading) return <View className="flex-1" />;
  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator />
    </View>
  );
}

function ReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-8">
      <Text className="text-center text-muted-foreground">{message}</Text>
      <Button onPress={onRetry} variant="outline">
        <Text>Try again</Text>
      </Button>
    </View>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <Text className="text-center text-muted-foreground">{text}</Text>
    </View>
  );
}
