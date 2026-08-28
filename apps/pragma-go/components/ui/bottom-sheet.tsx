import { type ReactNode, useEffect, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "@/lib/utils";

/** Duration of the panel's grow/shrink when its content height changes. */
const SHEET_RESIZE_MS = 220;

/** Gap kept between the top of the panel and the status bar. */
const TOP_GAP = 12;

/** Gap kept between the panel's bottom edge and a raised keyboard. */
const KEYBOARD_GAP = 10;

/** Gap kept below the panel's content when no keyboard is raised. */
const BOTTOM_GAP = 16;

/**
 * Whether a software keyboard is currently raised.
 *
 * The panel's bottom padding clears the home indicator, but with the keyboard
 * up the keyboard itself is what the panel sits on, so that inset becomes dead
 * space under the action row.
 */
function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // iOS reports the frame change before the animation; Android only emits the
    // `did` pair.
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /**
   * Action row pinned below the scrolling content. Keep the sheet's buttons
   * here: content scrolls away under a raised keyboard, a footer does not.
   */
  footer?: ReactNode;
  className?: string;
}

/**
 * Lightweight modal bottom sheet: a slide-up panel anchored to the bottom edge
 * with a tap-to-dismiss backdrop. Built on React Native's `Modal` so it needs no
 * extra native modules, following the React Native Reusables composition style.
 *
 * **The panel shrinks; it never slides off the top.** A sheet with a text field
 * gets pushed up by the keyboard, and a tall one (the launch form, say) pushed
 * by a tall keyboard would otherwise run past the status bar and lose its own
 * header. So the avoiding view owns the full screen minus the top inset, and
 * the panel is a `flexShrink` child of it with its content in a `ScrollView`:
 * whatever room the keyboard leaves is the most the panel can occupy, and the
 * rest scrolls.
 *
 * **Actions belong in `footer`, not in `children`.** Anything inside the
 * `ScrollView` is scrolled out of sight when the keyboard shrinks the panel, so
 * a submit button placed after a text field disappears exactly when the user is
 * ready to press it. The footer sits outside the scroller and stays put, and
 * with the keyboard up it sits `KEYBOARD_GAP` above it rather than over the
 * home-indicator inset, which the keyboard already covers.
 */
export function BottomSheet({ open, onOpenChange, children, footer, className }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const paddingBottom = keyboardVisible ? KEYBOARD_GAP : insets.bottom + BOTTOM_GAP;
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
        <KeyboardAvoidingView
          // Android resizes the window for the keyboard on its own; adding
          // padding on top of that would push the panel up twice.
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          pointerEvents="box-none"
          style={{ flexShrink: 1, justifyContent: "flex-end", paddingTop: insets.top + TOP_GAP }}
        >
          {/* The panel is sized by its content, which changes while the sheet is
              open (a revealed field, a validation error). `layout` animates that
              height change instead of snapping the whole panel. */}
          <Animated.View
            className={cn("rounded-t-2xl border border-border bg-card px-5 pt-3", className)}
            layout={LinearTransition.duration(SHEET_RESIZE_MS)}
            style={{ flexShrink: 1, paddingBottom }}
          >
            <View className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/40" />
            <ScrollView
              alwaysBounceVertical={false}
              contentContainerStyle={{ flexGrow: 1 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={{ flexShrink: 1 }}
            >
              {children}
            </ScrollView>
            {footer}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
