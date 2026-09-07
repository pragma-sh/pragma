import { useState } from "react";
import { Keyboard, Pressable, ScrollView, View } from "react-native";

import { GlassSurface } from "@/components/GlassSurface";
import { Text } from "@/components/ui/text";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/** One key: what it shows, and the bytes it sends. */
interface TerminalKey {
  label: string;
  /** Byte sequence sent as-is. */
  bytes: number[];
  accessibilityLabel: string;
}

const ESC = 0x1b;

/**
 * The keys a phone keyboard has no room for, in the order a terminal needs
 * them. Arrows are together because they are used together; Escape sits at the
 * far left where a hardware keyboard puts it.
 */
const PRIMARY_KEYS: TerminalKey[] = [
  { label: "esc", bytes: [ESC], accessibilityLabel: "Escape" },
  { label: "tab", bytes: [0x09], accessibilityLabel: "Tab" },
  { label: "^C", bytes: [0x03], accessibilityLabel: "Control C, interrupt" },
  { label: "←", bytes: [ESC, 0x5b, 0x44], accessibilityLabel: "Left arrow" },
  { label: "↓", bytes: [ESC, 0x5b, 0x42], accessibilityLabel: "Down arrow" },
  { label: "↑", bytes: [ESC, 0x5b, 0x41], accessibilityLabel: "Up arrow" },
  { label: "→", bytes: [ESC, 0x5b, 0x43], accessibilityLabel: "Right arrow" },
];

/**
 * The second row, scrollable.
 *
 * Ctrl-D is deliberately here rather than beside Ctrl-C: it ends the shell, and
 * a mis-tap next to the interrupt key would close the session the user was
 * trying to interrupt.
 */
const SECONDARY_KEYS: TerminalKey[] = [
  { label: "^D", bytes: [0x04], accessibilityLabel: "Control D, end of input" },
  { label: "^Z", bytes: [0x1a], accessibilityLabel: "Control Z, suspend" },
  { label: "^L", bytes: [0x0c], accessibilityLabel: "Control L, clear" },
  { label: "^R", bytes: [0x12], accessibilityLabel: "Control R, reverse search" },
  { label: "^A", bytes: [0x01], accessibilityLabel: "Control A, start of line" },
  { label: "^E", bytes: [0x05], accessibilityLabel: "Control E, end of line" },
  { label: "home", bytes: [ESC, 0x5b, 0x48], accessibilityLabel: "Home" },
  { label: "end", bytes: [ESC, 0x5b, 0x46], accessibilityLabel: "End" },
  { label: "pgup", bytes: [ESC, 0x5b, 0x35, 0x7e], accessibilityLabel: "Page up" },
  { label: "pgdn", bytes: [ESC, 0x5b, 0x36, 0x7e], accessibilityLabel: "Page down" },
];

/** Control-modified byte for a printable key, or null when there is none. */
export function controlByte(character: string): number | null {
  const code = character.toUpperCase().codePointAt(0);
  if (code === undefined) return null;
  // Ctrl-@ through Ctrl-_ are the C0 controls; nothing else has one.
  if (code >= 0x40 && code <= 0x5f) return code - 0x40;
  if (code === 0x3f) return 0x7f; // Ctrl-? is delete
  return null;
}

export interface TerminalKeyBarProps {
  /** Sends raw bytes to the PTY. */
  onSend: (bytes: Uint8Array) => void;
  /** Asks the renderer to paste, honouring the program's bracketed-paste mode. */
  onPaste: () => void;
  /** Whether sticky Ctrl is armed; the screen owns it so typing can consume it. */
  controlArmed: boolean;
  onToggleControl: () => void;
}

/**
 * The keys above the keyboard.
 *
 * A phone keyboard has no Escape, no Control, and no arrows, so a terminal is
 * unusable without them. Sticky Ctrl rather than a held modifier: there is no
 * chord to hold on a touch screen, so the next printable key consumes it.
 */
export function TerminalKeyBar({
  controlArmed,
  onPaste,
  onSend,
  onToggleControl,
}: TerminalKeyBarProps) {
  const [showSecondary, setShowSecondary] = useState(false);
  const send = (key: TerminalKey): void => {
    hapticSelection();
    onSend(new Uint8Array(key.bytes));
  };

  return (
    <GlassSurface className="border-t border-border">
      <View className="flex-row items-center gap-1 px-2 py-1.5">
        <KeyButton
          accessibilityLabel="Sticky control"
          active={controlArmed}
          label="ctrl"
          onPress={() => {
            hapticSelection();
            onToggleControl();
          }}
        />
        <ScrollView
          className="flex-1"
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
        >
          <View className="flex-row gap-1">
            {PRIMARY_KEYS.map((key) => (
              <KeyButton
                key={key.label}
                accessibilityLabel={key.accessibilityLabel}
                label={key.label}
                onPress={() => send(key)}
              />
            ))}
          </View>
        </ScrollView>
        <KeyButton
          accessibilityLabel={showSecondary ? "Hide more keys" : "Show more keys"}
          active={showSecondary}
          label="•••"
          onPress={() => setShowSecondary((open) => !open)}
        />
        <KeyButton
          accessibilityLabel="Hide keyboard"
          label="⌄"
          onPress={() => Keyboard.dismiss()}
        />
      </View>
      {showSecondary ? (
        <ScrollView
          className="border-t border-border"
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
        >
          <View className="flex-row gap-1 px-2 py-1.5">
            {SECONDARY_KEYS.map((key) => (
              <KeyButton
                key={key.label}
                accessibilityLabel={key.accessibilityLabel}
                label={key.label}
                onPress={() => send(key)}
              />
            ))}
            <KeyButton accessibilityLabel="Paste" label="paste" onPress={onPaste} />
          </View>
        </ScrollView>
      ) : null}
    </GlassSurface>
  );
}

function KeyButton({
  accessibilityLabel,
  active = false,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  active?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      // 44pt is the smallest target a thumb hits reliably; these keys are used
      // mid-command, where a mis-tap costs more than a wasted pixel row.
      className={cn(
        "min-h-[36px] min-w-[44px] items-center justify-center rounded-lg px-2 active:opacity-60",
        active ? "bg-primary" : "bg-muted",
      )}
      onPress={onPress}
    >
      <Text
        className={cn(
          "text-sm font-medium",
          active ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
