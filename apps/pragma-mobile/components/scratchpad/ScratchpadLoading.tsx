import { ActivityIndicator, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useThemeColors } from "@/lib/theme";

export interface ScratchpadLoadingProps {
  /** What is being waited on, e.g. "Loading scratchpad…". */
  label: string;
  /**
   * Cover the view behind it rather than take a slot of its own — used over the
   * web view, which has to stay mounted to render the document it is hiding.
   */
  overlay?: boolean;
}

/**
 * The one loading state a scratchpad shows.
 *
 * A scratchpad appears in two steps — the host serves the file, then the web
 * view evaluates its MDX — and both are slow enough to see. Rendering the same
 * spinner for each keeps that a single wait to the reader instead of a spinner
 * followed by a blank page.
 */
export function ScratchpadLoading({ label, overlay = false }: ScratchpadLoadingProps) {
  const colors = useThemeColors();
  return (
    <View
      className={`items-center justify-center gap-3 bg-background p-8 ${
        overlay ? "absolute bottom-0 left-0 right-0 top-0" : "flex-1"
      }`}
    >
      <ActivityIndicator color={colors.mutedForeground} size="large" />
      <Text className="text-center text-muted-foreground">{label}</Text>
    </View>
  );
}
