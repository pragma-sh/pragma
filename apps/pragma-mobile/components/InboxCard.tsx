import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import type { InboxResolution } from "@/lib/data/data-context";
import { hapticImpact, hapticSelection, hapticSuccess, hapticWarning } from "@/lib/haptics";
import type { InboxItem } from "@/lib/types";
import { IconSymbol } from "./IconSymbol";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Text } from "./ui/text";

const OTHER = "__other__";

interface InboxCardProps {
  item: InboxItem;
  onResolve: (resolution: InboxResolution) => void;
}

/**
 * A swipeable inbox card. Swipe right (drag from the left) to approve a command
 * or submit the selected answer; swipe left to deny. Both edges expose the same
 * actions as buttons. Resolving dismisses the card; every path is haptic.
 */
export function InboxCard({ item, onResolve }: InboxCardProps) {
  const swipeRef = useRef<SwipeableMethods>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");

  const isQuestion = item.kind === "question";

  /** The answer to submit for a question, or null when nothing valid is chosen. */
  function currentAnswer(): string | null {
    if (!isQuestion) return null;
    if (selected === OTHER) {
      const trimmed = otherText.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return selected;
  }

  function accept(): void {
    if (isQuestion) {
      const answer = currentAnswer();
      if (!answer) {
        hapticWarning();
        swipeRef.current?.close();
        return;
      }
      hapticSuccess();
      onResolve({ kind: "answer", option: answer });
      return;
    }
    hapticSuccess();
    onResolve({ kind: "approve" });
  }

  function deny(): void {
    hapticWarning();
    onResolve({ kind: "deny" });
  }

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      containerStyle={{ borderRadius: 12 }}
      friction={1.5}
      leftThreshold={72}
      renderLeftActions={(_progress, translation) => (
        <SwipeAction
          align="left"
          color="bg-success"
          fallback="✓"
          label={isQuestion ? "Submit" : "Approve"}
          sf="checkmark.circle.fill"
          translation={translation}
        />
      )}
      renderRightActions={(_progress, translation) => (
        <SwipeAction
          align="right"
          color="bg-destructive"
          fallback="✕"
          label="Deny"
          sf="xmark.circle.fill"
          translation={translation}
        />
      )}
      rightThreshold={72}
      onSwipeableWillOpen={() => hapticImpact()}
      onSwipeableOpen={(direction) => {
        // Swiping right reveals the LEFT action (accept); swiping left the right (deny).
        if (direction === "left") {
          accept();
        } else {
          deny();
        }
      }}
    >
      <Card>
        <CardHeader className="gap-2">
          <View className="flex-row items-center gap-2">
            <TypeBadge kind={item.kind} />
            <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              {item.projectName} · {item.worktreeLabel} · {item.agent}
            </Text>
          </View>
          <Text className="text-base font-semibold text-card-foreground">{item.prompt}</Text>
          {item.detail ? (
            <View className="rounded-md bg-muted px-3 py-2">
              <Text className="font-mono text-xs text-muted-foreground">{item.detail}</Text>
            </View>
          ) : null}
        </CardHeader>

        <CardContent className="gap-4">
          {isQuestion ? (
            <QuestionOptions
              onOther={(text) => setOtherText(text)}
              onSelect={(value) => {
                hapticSelection();
                setSelected(value);
              }}
              options={item.options ?? []}
              otherText={otherText}
              selected={selected}
            />
          ) : null}

          <View className="flex-row gap-3">
            <Button className="flex-1" variant="success" onPress={accept}>
              <IconSymbol color="white" fallback="✓" name="checkmark" size={16} tintColor="white" />
              <Text>{isQuestion ? "Submit" : "Approve"}</Text>
            </Button>
            <Button className="flex-1" variant="destructive" onPress={deny}>
              <IconSymbol color="white" fallback="✕" name="xmark" size={16} tintColor="white" />
              <Text>Deny</Text>
            </Button>
          </View>
          <Text className="text-center text-xs text-muted-foreground">
            Swipe right to {isQuestion ? "submit" : "approve"} · swipe left to deny
          </Text>
        </CardContent>
      </Card>
    </ReanimatedSwipeable>
  );
}

function QuestionOptions({
  options,
  selected,
  otherText,
  onSelect,
  onOther,
}: {
  options: string[];
  selected: string | null;
  otherText: string;
  onSelect: (value: string) => void;
  onOther: (text: string) => void;
}) {
  return (
    <RadioGroup onValueChange={onSelect} value={selected ?? ""}>
      {options.map((option) => (
        <OptionRow
          key={option}
          label={option}
          onPress={() => onSelect(option)}
          selected={selected === option}
          value={option}
        />
      ))}
      <OptionRow
        label="Other"
        onPress={() => onSelect(OTHER)}
        selected={selected === OTHER}
        value={OTHER}
      />
      {selected === OTHER ? (
        <Input
          autoFocus
          className="mt-1"
          placeholder="Type your answer…"
          value={otherText}
          onChangeText={onOther}
        />
      ) : null}
    </RadioGroup>
  );
}

function OptionRow({
  value,
  label,
  selected,
  onPress,
}: {
  value: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable className="flex-row items-center gap-3 py-1" onPress={onPress}>
      <RadioGroupItem aria-labelledby={`opt-${value}`} value={value} />
      <Text
        className={selected ? "flex-1 text-foreground" : "flex-1 text-muted-foreground"}
        nativeID={`opt-${value}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function TypeBadge({ kind }: { kind: InboxItem["kind"] }) {
  const isCommand = kind === "command";
  return (
    <View
      className={
        isCommand
          ? "rounded-full bg-warning/20 px-2 py-0.5"
          : "rounded-full bg-primary/15 px-2 py-0.5"
      }
    >
      <Text
        className={
          isCommand
            ? "text-xs font-semibold uppercase text-warning-foreground"
            : "text-xs font-semibold uppercase text-primary"
        }
      >
        {kind}
      </Text>
    </View>
  );
}

function SwipeAction({
  align,
  color,
  label,
  sf,
  fallback,
  translation,
}: {
  align: "left" | "right";
  color: string;
  label: string;
  sf: string;
  fallback: string;
  translation: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const magnitude = Math.min(Math.abs(translation.value) / 72, 1);
    return { opacity: 0.5 + magnitude * 0.5, transform: [{ scale: 0.8 + magnitude * 0.2 }] };
  });
  return (
    <View
      className={`my-0.5 flex-1 justify-center ${color} ${align === "left" ? "items-start pl-6" : "items-end pr-6"} rounded-xl`}
    >
      <Animated.View className="flex-row items-center gap-2" style={animatedStyle}>
        <IconSymbol
          color="white"
          fallback={fallback}
          name={sf as never}
          size={22}
          tintColor="white"
        />
        <Text className="font-semibold text-white">{label}</Text>
      </Animated.View>
    </View>
  );
}
