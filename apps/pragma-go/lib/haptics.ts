import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// Thin, intent-named wrappers around expo-haptics so screens describe *why*
// they buzz, not which raw API to call. No-ops on web where haptics are absent.
const enabled = Platform.OS === "ios" || Platform.OS === "android";

/** Light tick when moving the selection (row tap, radio change, swipe cross). */
export function hapticSelection(): void {
  if (enabled) void Haptics.selectionAsync();
}

/** Medium tap for committing a navigation push or opening a surface. */
export function hapticImpact(
  style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light,
): void {
  if (enabled) void Haptics.impactAsync(style);
}

/** Success cue — an approved command or a submitted answer. */
export function hapticSuccess(): void {
  if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** Warning cue — a denied command or question. */
export function hapticWarning(): void {
  if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}
