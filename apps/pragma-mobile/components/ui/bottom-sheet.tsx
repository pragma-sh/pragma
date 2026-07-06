import { type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "@/lib/utils";

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
          <View
            className={cn("rounded-t-2xl border border-border bg-card px-5 pt-3", className)}
            style={{ paddingBottom: insets.bottom + 16 }}
          >
            <View className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" />
            {children}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
