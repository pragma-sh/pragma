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
/**
 * Wire delimiter joining a multi-question wizard's answers into one reply.
 * The ASCII unit separator, not `" | "`: an option label or free-text answer
 * can legitimately contain `" | "`, which would corrupt the question/answer
 * mapping on the consuming end (see `packages/watcher-kit` and
 * `packages/claude-code-plugin/hooks/report.sh`).
 */
const ANSWER_SEPARATOR = "\x1f";

interface AttentionDockProps {
  request: AttentionRequest;
  onDecide: (requestId: string, approved: boolean) => void;
  onAnswer: (requestId: string, reply: string | null) => void;
}

interface QuestionEntry {
  question: string;
  options: QuestionOption[];
}

interface QuestionDraft {
  selected: string | null;
  otherText: string;
}

interface QuestionActionsProps {
  request: AttentionRequest;
  onAnswer: (requestId: string, reply: string | null) => void;
}

/**
 * Docked action card for a live agent request, using the Inbox card's visual
 * language. A `command` shows Approve/Deny; a `question` shows its options (plus
 * a free-text "Other") and Submit/Dismiss. Multi-question requests render a
 * back/next wizard with a final submit-all summary line.
 */
export function AttentionDock({ request, onDecide, onAnswer }: AttentionDockProps) {
  const isQuestion = request.kind === "question";
  return (
    <View className="px-3 pb-2 pt-1">
      <Card>
        {isQuestion ? (
          <QuestionActions key={request.requestId} request={request} onAnswer={onAnswer} />
        ) : (
          <>
            <CardHeader className="gap-2">
              <RequestTypeBadge kind={request.kind} />
              <Text className="text-base font-semibold text-card-foreground">{request.prompt}</Text>
            </CardHeader>
            <CardContent className="gap-4">
              <CommandActions request={request} onDecide={onDecide} />
            </CardContent>
          </>
        )}
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

function QuestionActions({ request, onAnswer }: QuestionActionsProps) {
  const questions = questionEntries(request);
  if (questions.length <= 1) {
    const question = questions[0] ?? { question: request.prompt, options: request.options ?? [] };
    return (
      <SingleQuestionActions
        onAnswer={onAnswer}
        options={question.options}
        prompt={question.question}
        requestId={request.requestId}
      />
    );
  }

  return <QuestionWizard onAnswer={onAnswer} questions={questions} request={request} />;
}

function QuestionWizard({
  request,
  questions,
  onAnswer,
}: QuestionActionsProps & { questions: QuestionEntry[] }) {
  const [current, setCurrent] = useState(0);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => ({ selected: null, otherText: "" })),
  );

  const active = questionAt(questions, current);
  const draft = drafts[current] ?? { selected: null, otherText: "" };
  const answers = drafts.map(answerForDraft);
  const allAnswered = answers.every(Boolean);
  const last = questions.length - 1;

  return (
    <>
      <CardHeader className="gap-2">
        <QuestionWizardHeader
          current={current}
          disabled={!answerForDraft(draft)}
          last={last}
          onBack={() => setCurrent(Math.max(0, current - 1))}
          onNext={() => setCurrent(Math.min(last, current + 1))}
        />
        <RequestTypeBadge kind={request.kind} />
        <Text className="text-base font-semibold text-card-foreground">{active.question}</Text>
      </CardHeader>
      <CardContent className="gap-4">
        <QuestionOptions
          options={active.options}
          selected={draft.selected}
          onSelect={(selected) => {
            hapticSelection();
            setDrafts((previous) => updateQuestionDraft(previous, current, { selected }));
          }}
        />
        <QuestionAnswerInput
          otherText={draft.otherText}
          onOtherTextChange={(otherText) =>
            setDrafts((previous) => updateQuestionDraft(previous, current, { otherText }))
          }
          selected={draft.selected}
          show={active.options.length === 0 || draft.selected === OTHER}
        />
        <QuestionWizardFooter
          allAnswered={allAnswered}
          answers={answers}
          current={current}
          disabled={!answerForDraft(draft)}
          last={last}
          onDismiss={() => onAnswer(request.requestId, null)}
          onNext={() => setCurrent(Math.min(last, current + 1))}
          onSubmitAll={() => {
            if (!allAnswered) return;
            hapticSelection();
            onAnswer(request.requestId, answers.join(ANSWER_SEPARATOR));
          }}
        />
      </CardContent>
    </>
  );
}

function updateQuestionDraft(
  drafts: QuestionDraft[],
  current: number,
  patch: Partial<QuestionDraft>,
): QuestionDraft[] {
  return drafts.map((entry, index) => (index === current ? { ...entry, ...patch } : entry));
}

function SingleQuestionActions({
  onAnswer,
  options,
  prompt,
  requestId,
}: {
  onAnswer: (requestId: string, reply: string | null) => void;
  options: QuestionOption[];
  prompt: string;
  requestId: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");

  function submit(): void {
    const reply = selected === OTHER ? otherText.trim() : selected;
    if (!reply) return;
    hapticSelection();
    onAnswer(requestId, reply);
  }

  return (
    <>
      <CardHeader className="gap-2">
        <RequestTypeBadge kind="question" />
        <Text className="text-base font-semibold text-card-foreground">{prompt}</Text>
      </CardHeader>
      <CardContent className="gap-4">
        <QuestionOptions options={options} selected={selected} onSelect={setSelected} />
        <QuestionAnswerInput
          otherText={otherText}
          onOtherTextChange={setOtherText}
          selected={selected}
          show={options.length === 0 || selected === OTHER}
        />
        <QuestionActionButtons onDismiss={() => onAnswer(requestId, null)} onSubmit={submit} />
      </CardContent>
    </>
  );
}

function QuestionWizardHeader({
  current,
  disabled,
  last,
  onBack,
  onNext,
}: {
  current: number;
  disabled: boolean;
  last: number;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Button disabled={current === 0} onPress={onBack} variant="ghost">
        <IconSymbol color="black" fallback="‹" name="chevron.left" size={16} />
        <Text>Back</Text>
      </Button>
      <Text className="text-xs text-muted-foreground">
        Question {current + 1} of {last + 1}
      </Text>
      {current < last ? (
        <Button disabled={disabled} onPress={onNext} variant="ghost">
          <Text>Next</Text>
          <IconSymbol color="black" fallback="›" name="chevron.right" size={16} />
        </Button>
      ) : (
        <View className="w-16" />
      )}
    </View>
  );
}

function QuestionWizardFooter({
  allAnswered,
  answers,
  disabled,
  last,
  current,
  onDismiss,
  onNext,
  onSubmitAll,
}: {
  allAnswered: boolean;
  answers: string[];
  current: number;
  disabled: boolean;
  last: number;
  onDismiss: () => void;
  onNext: () => void;
  onSubmitAll: () => void;
}) {
  if (current < last) {
    return (
      <View className="flex-row justify-end gap-3">
        <Button onPress={onDismiss} variant="ghost">
          <Text>Dismiss</Text>
        </Button>
        <Button className="flex-1" disabled={disabled} onPress={onNext} variant="success">
          <Text>Next</Text>
        </Button>
      </View>
    );
  }
  return (
    <View className="gap-3">
      {allAnswered ? (
        <Text className="text-sm text-muted-foreground" numberOfLines={2}>
          {answers.join(" | ")}
        </Text>
      ) : (
        <Text className="text-sm text-muted-foreground">Answer every question to submit.</Text>
      )}
      <View className="flex-row gap-3">
        <Button onPress={onDismiss} variant="ghost">
          <Text>Dismiss</Text>
        </Button>
        <Button className="flex-1" disabled={!allAnswered} onPress={onSubmitAll} variant="success">
          <Text>Submit all</Text>
        </Button>
      </View>
    </View>
  );
}

function questionEntries(request: AttentionRequest): QuestionEntry[] {
  if (request.questions && request.questions.length > 0) {
    return request.questions.map((question) => ({
      question: question.question,
      options: question.options ?? [],
    }));
  }
  return [{ question: request.prompt, options: request.options ?? [] }];
}

function questionAt(questions: QuestionEntry[], current: number): QuestionEntry {
  return questions[current] ?? questions[0]!;
}

function answerForDraft(draft: QuestionDraft | undefined): string {
  if (!draft) return "";
  return draft.selected === OTHER ? draft.otherText.trim() : (draft.selected ?? "");
}

function QuestionOptions({
  onSelect,
  options,
  selected,
}: {
  onSelect: (value: string) => void;
  options: QuestionOption[];
  selected: string | null;
}) {
  if (options.length === 0) return null;
  function select(value: string): void {
    hapticSelection();
    onSelect(value);
  }
  return (
    <RadioGroup onValueChange={select} value={selected ?? ""}>
      {options.map((option) => (
        <OptionRow
          key={option.label}
          description={option.description}
          label={option.label}
          onPress={() => select(option.label)}
          selected={selected === option.label}
          value={option.label}
        />
      ))}
      <OptionRow
        label="Other"
        onPress={() => select(OTHER)}
        selected={selected === OTHER}
        value={OTHER}
      />
    </RadioGroup>
  );
}

function QuestionAnswerInput({
  onOtherTextChange,
  otherText,
  selected,
  show,
}: {
  onOtherTextChange: (text: string) => void;
  otherText: string;
  selected: string | null;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <Input
      autoFocus={selected === OTHER || show}
      onChangeText={onOtherTextChange}
      placeholder="Type your answer…"
      value={otherText}
    />
  );
}

function QuestionActionButtons({
  onDismiss,
  onSubmit,
}: {
  onDismiss: () => void;
  onSubmit: () => void;
}) {
  return (
    <View className="flex-row gap-3">
      <Button className="flex-1" variant="success" onPress={onSubmit}>
        <Text>Submit</Text>
      </Button>
      <Button variant="ghost" onPress={onDismiss}>
        <Text>Dismiss</Text>
      </Button>
    </View>
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
