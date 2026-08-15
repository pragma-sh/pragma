import { type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "@/lib/utils";

/** Duration of the panel's grow/shrink when its content height changes. */
const SHEET_RESIZE_MS = 220;

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Lightweight modal bottom sheet: a slide-up panel anchored to the bottom edge
 * with a tap-to-dismiss backdrop. Built on React Native's `Modal` so it needs no
 * extra native modules, following the React Native Reusables composition style.
 */
export function BottomSheet({ open, onOpenChange, children, className }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => onOpenChange(false)}
      statusBarTranslucent
      transparent
      visible={open}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="absolute inset-0 bg-black/50"
          onPress={() => onOpenChange(false)}
        />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          {/* The panel is sized by its content, which changes while the sheet is
              open (a revealed field, a validation error). `layout` animates that
              height change instead of snapping the whole panel. */}
          <Animated.View
            className={cn("rounded-t-2xl border border-border bg-card px-5 pt-3", className)}
            layout={LinearTransition.duration(SHEET_RESIZE_MS)}
            style={{ paddingBottom: insets.bottom + 16 }}
          >
            <View className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" />
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
