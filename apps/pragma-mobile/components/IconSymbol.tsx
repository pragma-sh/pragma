import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { Platform } from "react-native";

import { Text } from "./ui/text";

interface IconSymbolProps {
  /** SF Symbol name used on iOS. */
  name: SymbolViewProps["name"];
  /** Unicode glyph fallback rendered on Android/web. */
  fallback: string;
  size?: number;
  className?: string;
  color?: string;
  tintColor?: string;
}

// SF Symbols on Apple platforms for a first-class native look; a lightweight
// unicode glyph elsewhere so we don't pull in a whole icon font just for chevrons.
/** Cross-platform icon: SF Symbol on iOS, unicode glyph fallback otherwise. */
export function IconSymbol({
  name,
  fallback,
  size = 20,
  className,
  color,
  tintColor,
}: IconSymbolProps) {
  if (Platform.OS === "ios") {
    return <SymbolView name={name} size={size} tintColor={tintColor ?? color} />;
  }
  return (
    <Text className={className} style={{ fontSize: size, color }}>
      {fallback}
    </Text>
  );
}
