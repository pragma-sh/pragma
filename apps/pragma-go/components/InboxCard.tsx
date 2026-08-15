import { type RefObject, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import type { InboxResolution } from "@/lib/data/data-context";
import { hapticImpact, hapticSelection, hapticSuccess, hapticWarning } from "@/lib/haptics";
import type { InboxItem } from "@/lib/types";
import { useThemeColors } from "@/lib/theme";
import { useCatalogAgent } from "@/lib/use-catalog";
import type { QuestionOption } from "@pragma/constants";
import { AgentIcon } from "./AgentIcon";
import { IconSymbol } from "./IconSymbol";
import { RequestTypeBadge } from "./RequestTypeBadge";
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
  const { destructiveForeground, successForeground } = useThemeColors();
  const { accept, acceptLabel, deny, denyLabel, handleSwipeOpen, isQuestion } = useInboxActions({
    item,
    onResolve,
    otherText,
    selected,
    swipeRef,
  });

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      containerStyle={{ borderRadius: 16 }}
      friction={1.5}
      leftThreshold={72}
      renderLeftActions={(_progress, translation) => (
        <SwipeAction
          align="left"
          color="bg-success"
          fallback="✓"
          foreground={successForeground}
          foregroundClass="text-success-foreground"
          label={acceptLabel}
          sf="checkmark.circle.fill"
          translation={translation}
        />
      )}
      renderRightActions={(_progress, translation) => (
        <SwipeAction
          align="right"
          color="bg-destructive"
          fallback="✕"
          foreground={destructiveForeground}
          foregroundClass="text-destructive-foreground"
          label="Deny"
          sf="xmark.circle.fill"
          translation={translation}
        />
      )}
      rightThreshold={72}
      onSwipeableWillOpen={() => hapticImpact()}
      onSwipeableOpen={handleSwipeOpen}
    >
      <Card>
        <InboxCardHeader item={item} />
        <InboxCardContent
          acceptLabel={acceptLabel}
          denyLabel={denyLabel}
          isQuestion={isQuestion}
          item={item}
          onAccept={accept}
          onDeny={deny}
          onOther={setOtherText}
          onSelect={setSelected}
          otherText={otherText}
          selected={selected}
        />
      </Card>
    </ReanimatedSwipeable>
  );
}

function useInboxActions({
  item,
  onResolve,
  otherText,
  selected,
  swipeRef,
}: {
  item: InboxItem;
  onResolve: (resolution: InboxResolution) => void;
  otherText: string;
  selected: string | null;
  swipeRef: RefObject<SwipeableMethods | null>;
}) {
  const isQuestion = item.kind === "question";
  const acceptLabel = isQuestion ? "Submit" : "Approve";
  const denyLabel = isQuestion ? "Dismiss" : "Deny";

  function accept(): void {
    if (!isQuestion) {
      hapticSuccess();
      onResolve({ kind: "approve" });
      return;
    }
    acceptQuestion(otherText, selected, swipeRef, onResolve);
  }

  function deny(): void {
    hapticWarning();
    onResolve({ kind: "deny" });
  }

  function handleSwipeOpen(direction: "left" | "right"): void {
    // Swiping right reveals the LEFT action (accept); swiping left the right (deny).
    if (direction === "right") accept();
    else deny();
  }

  return { accept, acceptLabel, deny, denyLabel, handleSwipeOpen, isQuestion };
}

function acceptQuestion(
  otherText: string,
  selected: string | null,
  swipeRef: RefObject<SwipeableMethods | null>,
  onResolve: (resolution: InboxResolution) => void,
): void {
  const answer = selected === OTHER ? otherText.trim() : selected;
  if (!answer) {
    hapticWarning();
    swipeRef.current?.close();
    return;
  }
  hapticSuccess();
  onResolve({ kind: "answer", option: answer });
}

interface InboxCardContentProps {
  acceptLabel: string;
  denyLabel: string;
  isQuestion: boolean;
  item: InboxItem;
  onAccept: () => void;
  onDeny: () => void;
  onOther: (text: string) => void;
  onSelect: (value: string) => void;
  otherText: string;
  selected: string | null;
}

function InboxCardContent({
  acceptLabel,
  denyLabel,
  isQuestion,
  item,
  onAccept,
  onDeny,
  onOther,
  onSelect,
  otherText,
  selected,
}: InboxCardContentProps) {
  function select(value: string): void {
    hapticSelection();
    onSelect(value);
  }

  return (
    <CardContent className="gap-4">
      {isQuestion ? (
        <QuestionOptions
          onOther={onOther}
          onSelect={select}
          options={item.options}
          otherText={otherText}
          selected={selected}
        />
      ) : null}
      <InboxCardButtons
        acceptLabel={acceptLabel}
        denyLabel={denyLabel}
        isQuestion={isQuestion}
        onAccept={onAccept}
        onDeny={onDeny}
      />
    </CardContent>
  );
}

function InboxCardButtons({
  acceptLabel,
  denyLabel,
  isQuestion,
  onAccept,
  onDeny,
}: {
  acceptLabel: string;
  denyLabel: string;
  isQuestion: boolean;
  onAccept: () => void;
  onDeny: () => void;
}) {
  const { destructiveForeground, successForeground } = useThemeColors();
  return (
    <View className="flex-row justify-end gap-2">
      <Button
        accessibilityLabel={denyLabel}
        accessibilityHint="Dismiss this request"
        className="h-12 w-12 rounded-full"
        onPress={onDeny}
        size="icon"
        variant="destructive"
      >
        <IconSymbol
          color={destructiveForeground}
          fallback="✕"
          name="xmark"
          size={20}
          tintColor={destructiveForeground}
        />
      </Button>
      <Button
        accessibilityLabel={acceptLabel}
        accessibilityHint={isQuestion ? "Submit selected answer" : "Approve this command"}
        className="h-12 w-12 rounded-full"
        onPress={onAccept}
        size="icon"
        variant="success"
      >
        <IconSymbol
          color={successForeground}
          fallback="✓"
          name="checkmark"
          size={20}
          tintColor={successForeground}
        />
      </Button>
    </View>
  );
}

/** Card header: type badge, source path, prompt, and optional detail block. */
function InboxCardHeader({ item }: { item: InboxItem }) {
  const catalogAgent = useCatalogAgent(item.agent);
  return (
    <CardHeader className="gap-2.5">
      <View className="flex-row items-center justify-between">
        <RequestTypeBadge kind={item.kind} />
        <View className="flex-row items-center gap-1.5">
          <AgentIcon fallback="◆" icon={catalogAgent?.icon} size={14} />
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {item.worktreeLabel}
          </Text>
        </View>
      </View>
      <View>
        <Text className="text-base font-semibold text-card-foreground">{item.prompt}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {item.projectName}
        </Text>
      </View>
      {item.detail ? (
        <View className="rounded-lg border border-border bg-muted/60 px-3 py-2">
          <Text className="font-mono text-xs text-muted-foreground">{item.detail}</Text>
        </View>
      ) : null}
    </CardHeader>
  );
}

function QuestionOptions({
  options,
  selected,
  otherText,
  onSelect,
  onOther,
}: {
  options: QuestionOption[] | undefined;
  selected: string | null;
  otherText: string;
  onSelect: (value: string) => void;
  onOther: (text: string) => void;
}) {
  return (
    <RadioGroup onValueChange={onSelect} value={selected ?? ""}>
      {(options ?? []).map((option) => (
        <OptionRow
          key={option.label}
          description={option.description}
          label={option.label}
          onPress={() => onSelect(option.label)}
          selected={selected === option.label}
          value={option.label}
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
  description,
  selected,
  onPress,
}: {
  value: string;
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable className="flex-row items-center gap-3 py-1" onPress={onPress}>
      <RadioGroupItem aria-labelledby={`opt-${value}`} value={value} />
      <View className="flex-1">
        <Text
          className={selected ? "text-foreground" : "text-muted-foreground"}
          nativeID={`opt-${value}`}
        >
          {label}
        </Text>
        {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
      </View>
    </Pressable>
  );
}

function SwipeAction({
  align,
  color,
  foreground,
  foregroundClass,
  label,
  sf,
  fallback,
  translation,
}: {
  align: "left" | "right";
  color: string;
  /** Literal colour for the SF Symbol, which takes no class. */
  foreground: string;
  /** The matching `*-foreground` class for the label. */
  foregroundClass: string;
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
      className={`my-0.5 flex-1 justify-center ${color} ${align === "left" ? "items-start pl-6" : "items-end pr-6"} rounded-2xl`}
    >
      <Animated.View className="flex-row items-center gap-2" style={animatedStyle}>
        <IconSymbol
          color={foreground}
          fallback={fallback}
          name={sf as never}
          size={22}
          tintColor={foreground}
        />
        <Text className={`font-semibold ${foregroundClass}`}>{label}</Text>
      </Animated.View>
    </View>
  );
}
