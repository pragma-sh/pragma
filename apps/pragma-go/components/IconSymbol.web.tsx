import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  FileText,
  Folder,
  GitBranch,
  Inbox,
  MessagesSquare,
  Plus,
  Settings,
  Square,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ColorValue } from "react-native";

import { Text } from "./ui/text";

// Web counterpart of `IconSymbol.tsx`. SF Symbols are an Apple system font with
// no browser equivalent, so each symbol the app uses is mapped to the closest
// Lucide icon by hand.
//
// The map is explicit, and the imports above are named, so the bundler ships
// only these icons rather than Lucide's full set — the reason this is a literal
// table and not a lookup by generated name. Anything missing falls back to the
// caller's unicode glyph, which is what Android renders today, so an unmapped
// symbol degrades instead of disappearing.

const LUCIDE_BY_SF_SYMBOL: Record<string, LucideIcon> = {
  "arrow.triangle.branch": GitBranch,
  "arrow.up": ArrowUp,
  "bubble.left.and.text.bubble.right": MessagesSquare,
  "checkmark.circle.fill": CircleCheck,
  checkmark: Check,
  "chevron.left": ChevronLeft,
  "chevron.right": ChevronRight,
  "chevron.up.chevron.down": ChevronsUpDown,
  "circle.fill": Circle,
  "doc.text": FileText,
  "folder.fill": Folder,
  "gearshape.fill": Settings,
  plus: Plus,
  "questionmark.circle.fill": CircleQuestionMark,
  "stop.fill": Square,
  "terminal.fill": Terminal,
  "tray.full.fill": Inbox,
  tray: Inbox,
  "xmark.circle.fill": CircleX,
  "xmark.circle": CircleX,
  xmark: X,
};

/** Symbols whose SF form is filled; Lucide draws outlines unless told otherwise. */
const FILLED_SF_SYMBOLS = new Set([
  "checkmark.circle.fill",
  "circle.fill",
  "stop.fill",
  "xmark.circle.fill",
]);

interface IconSymbolProps {
  /** SF Symbol name; mapped to a Lucide icon here. */
  name: string;
  /** Unicode glyph fallback rendered when the symbol has no mapping. */
  fallback: string;
  size?: number;
  className?: string;
  color?: ColorValue;
  tintColor?: ColorValue;
}

/** Cross-platform icon: a Lucide SVG on web, an SF Symbol on iOS. */
export function IconSymbol({
  name,
  fallback,
  size = 20,
  className,
  color,
  tintColor,
}: IconSymbolProps) {
  const Icon = LUCIDE_BY_SF_SYMBOL[name];
  const resolved = cssColor(tintColor ?? color);
  if (!Icon) {
    return (
      <Text className={className} style={{ fontSize: size, color }}>
        {fallback}
      </Text>
    );
  }
  return (
    <Icon
      aria-hidden
      color={resolved}
      fill={FILLED_SF_SYMBOLS.has(name) ? resolved : "none"}
      size={size}
    />
  );
}

/**
 * React Native accepts numeric and symbol color values that CSS does not.
 * Anything that is not already a CSS string is left to Lucide's default, which
 * is `currentColor` and therefore still inherits something sensible.
 */
function cssColor(value: ColorValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
