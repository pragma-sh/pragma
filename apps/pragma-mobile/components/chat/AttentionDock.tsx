import { useState } from "react";
import { Pressable, View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { RequestTypeBadge } from "@/components/RequestTypeBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Text } from "@/components/ui/text";
import { hapticSelection } from "@/lib/haptics";
import type { AttentionRequest } from "@/lib/types";
import type { QuestionOption } from "@pragma/constants";

const OTHER = "__other__";

interface AttentionDockProps {
  request: AttentionRequest;
  onDecide: (requestId: string, approved: boolean) => void;
  onAnswer: (requestId: string, reply: string | null) => void;
}

/**
 * Docked action card for a live agent request, using the Inbox card's visual
 * language. A `command` shows Approve/Deny; a `question` shows its options (plus
 * a free-text "Other") and Submit/Dismiss. Mirrors InboxCard so the two
 * surfaces read the same.
 */
export function AttentionDock({ request, onDecide, onAnswer }: AttentionDockProps) {
  const isQuestion = request.kind === "question";
  return (
    <View className="px-3 pb-2 pt-1">
      <Card>
        <CardHeader className="gap-2">
          <RequestTypeBadge kind={request.kind} />
          <Text className="text-base font-semibold text-card-foreground">{request.prompt}</Text>
        </CardHeader>
        <CardContent className="gap-4">
          {isQuestion ? (
            <QuestionActions request={request} onAnswer={onAnswer} />
          ) : (
            <CommandActions request={request} onDecide={onDecide} />
          )}
        </CardContent>
      </Card>
    </View>
  );
}

function CommandActions({
  request,
  onDecide,
}: {
  request: AttentionRequest;
  onDecide: (requestId: string, approved: boolean) => void;
}) {
  return (
    <View className="flex-row gap-3">
      <Button
        className="flex-1"
        variant="success"
        onPress={() => onDecide(request.requestId, true)}
      >
        <IconSymbol color="white" fallback="✓" name="checkmark" size={16} tintColor="white" />
        <Text>Approve</Text>
      </Button>
      <Button
        className="flex-1"
        variant="destructive"
        onPress={() => onDecide(request.requestId, false)}
      >
        <IconSymbol color="white" fallback="✕" name="xmark" size={16} tintColor="white" />
        <Text>Deny</Text>
      </Button>
    </View>
  );
}

function QuestionActions({
  request,
  onAnswer,
}: {
  request: AttentionRequest;
  onAnswer: (requestId: string, reply: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const options = request.options ?? [];

  function submit(): void {
    const reply = selected === OTHER ? otherText.trim() : selected;
    if (!reply) return;
    onAnswer(request.requestId, reply);
  }

  return (
    <>
      {options.length > 0 ? (
        <RadioGroup
          onValueChange={(value) => {
            hapticSelection();
            setSelected(value);
          }}
          value={selected ?? ""}
        >
          {options.map((option) => (
            <OptionRow
              key={option.label}
              description={option.description}
              label={option.label}
              onPress={() => setSelected(option.label)}
              selected={selected === option.label}
              value={option.label}
            />
          ))}
          <OptionRow
            label="Other"
            onPress={() => setSelected(OTHER)}
            selected={selected === OTHER}
            value={OTHER}
          />
        </RadioGroup>
      ) : null}
      {options.length === 0 || selected === OTHER ? (
        <Input
          autoFocus={selected === OTHER}
          onChangeText={setOtherText}
          placeholder="Type your answer…"
          value={otherText}
        />
      ) : null}
      <View className="flex-row gap-3">
        <Button className="flex-1" variant="success" onPress={submit}>
          <Text>Submit</Text>
        </Button>
        <Button variant="ghost" onPress={() => onAnswer(request.requestId, null)}>
          <Text>Dismiss</Text>
        </Button>
      </View>
    </>
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
  description?: QuestionOption["description"];
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable className="flex-row items-center gap-3 py-1" onPress={onPress}>
      <RadioGroupItem aria-labelledby={`dock-opt-${value}`} value={value} />
      <View className="flex-1">
        <Text
          className={selected ? "text-foreground" : "text-muted-foreground"}
          nativeID={`dock-opt-${value}`}
        >
          {label}
        </Text>
        {description ? <Text className="text-xs text-muted-foreground">{description}</Text> : null}
      </View>
    </Pressable>
  );
}
