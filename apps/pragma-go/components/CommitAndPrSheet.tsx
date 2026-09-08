import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { stageLabel, type CommitAndPr } from "@/lib/use-commit-and-pr";

/**
 * The Commit & PR flow, as three states of one sheet.
 *
 * The order matters and is the desktop's: commit everything into logical
 * commits, *then* review the pull request text, *then* publish. Committing is
 * local and undoable in the ordinary git sense; publishing is neither, so it
 * never happens as a side effect of the first tap.
 */
export function CommitAndPrSheet({
  flow,
  onOpenChange,
  open,
}: {
  flow: CommitAndPr;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <BottomSheet onOpenChange={onOpenChange} open={open}>
      {flow.phase === "idle" ? <ConfirmStep flow={flow} /> : null}
      {flow.phase === "running" ? <RunningStep flow={flow} /> : null}
      {flow.phase === "review" || flow.phase === "publishing" ? (
        <ReviewStep flow={flow} onDone={() => onOpenChange(false)} />
      ) : null}
      {flow.phase === "failed" ? <FailedStep flow={flow} /> : null}
    </BottomSheet>
  );
}

/** What is about to happen, before anything happens. */
function ConfirmStep({ flow }: { flow: CommitAndPr }) {
  const [starting, setStarting] = useState(false);
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">Commit all changes</Text>
      <Text className="text-sm text-muted-foreground">
        Every uncommitted change in this worktree — including new files — is grouped into commits.
        Nothing is pushed yet: you review the pull request text first.
      </Text>
      <View className="mt-5">
        <Button
          disabled={starting}
          onPress={() => {
            setStarting(true);
            void flow
              .start()
              .catch((error: unknown) => {
                hapticWarning();
                Alert.alert(
                  "Couldn't start",
                  error instanceof Error ? error.message : "The host could not start this run.",
                );
              })
              .finally(() => setStarting(false));
          }}
        >
          <Text>{starting ? "Starting…" : "Commit changes"}</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * Progress. The run belongs to the host, so this says so: closing the sheet or
 * leaving the app does not stop it.
 */
function RunningStep({ flow }: { flow: CommitAndPr }) {
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">
        {flow.job ? stageLabel(flow.job) : "Working…"}
      </Text>
      <Text className="text-sm text-muted-foreground">
        This runs on your computer. You can leave this screen — it keeps going, and the result is
        here when you come back.
      </Text>
      <View className="mt-5">
        <Button onPress={() => void flow.cancel().catch(() => undefined)} variant="outline">
          <Text>Stop after this step</Text>
        </Button>
      </View>
    </View>
  );
}

/** The draft, editable, with the one button that publishes. */
function ReviewStep({ flow, onDone }: { flow: CommitAndPr; onDone: () => void }) {
  // The host's draft is the value until the user types over it. Held as
  // "what the user changed" rather than copied into state on arrival, so the
  // draft can land after the sheet opens without an effect racing the edits.
  const [edits, setEdits] = useState<{ title?: string; body?: string }>({});
  const [draft, setDraft] = useState(false);
  const title = edits.title ?? flow.job?.title ?? "";
  const body = edits.body ?? flow.job?.body ?? "";

  const publishing = flow.phase === "publishing";
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">
        {flow.job ? stageLabel(flow.job) : "Ready"}
      </Text>
      <Text className="text-sm text-muted-foreground">
        Review the pull request before it is pushed.
      </Text>
      <ScrollView className="mt-4 max-h-72" keyboardShouldPersistTaps="handled">
        <View className="gap-3">
          <Input
            onChangeText={(next) => setEdits((current) => ({ ...current, title: next }))}
            placeholder="Title"
            value={title}
          />
          <Input
            multiline
            numberOfLines={6}
            onChangeText={(next) => setEdits((current) => ({ ...current, body: next }))}
            placeholder="Description"
            style={{ minHeight: 120, textAlignVertical: "top" }}
            value={body}
          />
        </View>
      </ScrollView>
      <View className="mt-4 gap-3">
        <Button onPress={() => setDraft((value) => !value)} variant="outline">
          <Text>{draft ? "Open as draft ✓" : "Open as draft"}</Text>
        </Button>
        <Button
          disabled={publishing || !title.trim()}
          onPress={() => {
            void flow
              .publish({ title: title.trim(), body, draft })
              .then(() => {
                hapticSuccess();
                onDone();
                return undefined;
              })
              .catch((error: unknown) => {
                hapticWarning();
                Alert.alert(
                  "Couldn't publish",
                  error instanceof Error
                    ? error.message
                    : "The branch could not be pushed or the pull request created.",
                );
              });
          }}
        >
          <Text>{publishing ? "Pushing…" : "Push & create PR"}</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * A run that did not finish.
 *
 * It always reports what was committed anyway: after a failure partway through,
 * "three commits were made" is the difference between looking for lost work and
 * knowing exactly where it is.
 */
function FailedStep({ flow }: { flow: CommitAndPr }) {
  const committed = flow.job?.commitCount ?? 0;
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">
        {flow.job ? stageLabel(flow.job) : "Failed"}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {flow.job?.error ?? "The run did not finish."}
      </Text>
      {committed > 0 ? (
        <Text className="mt-2 text-sm text-foreground">
          {committed} {committed === 1 ? "commit was" : "commits were"} already made and{" "}
          {committed === 1 ? "is" : "are"} still on your branch.
        </Text>
      ) : null}
      <View className="mt-5">
        <Button onPress={flow.reset} variant="outline">
          <Text>Start over</Text>
        </Button>
      </View>
    </View>
  );
}
