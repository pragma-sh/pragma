import type { AiJob, GitHubBranches } from "@pragma-sh/sdk";
import { type ComponentType, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type MenuAction, MenuView } from "@/components/ui/menu-view";
import { Text } from "@/components/ui/text";
import { baseBranchChoices } from "@/lib/base-branches";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import { stageLabel, type CommitAndPr, type CommitAndPrPhase } from "@/lib/use-commit-and-pr";
import { errorText } from "@/lib/utils";

/**
 * The Commit & PR flow, as three states of one sheet.
 *
 * The order matters and is the desktop's: commit everything into logical
 * commits, *then* review the pull request text, *then* publish. Committing is
 * local and undoable in the ordinary git sense; publishing is neither, so it
 * never happens as a side effect of the first tap.
 *
 * The running stretch has no state here: starting closes the sheet, the screen's
 * header action carries the progress, and the sheet comes back by itself on the
 * pull request draft. The run belongs to the host, so there is nothing to keep
 * on screen while it works.
 */
export function CommitAndPrSheet({
  flow,
  onOpenChange,
  open,
  worktreeName,
}: {
  flow: CommitAndPr;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** What the worktree is called, shown as the head of the pull request. */
  worktreeName: string;
}) {
  const Step = PHASE_STEPS[flow.phase];
  return (
    <BottomSheet onOpenChange={onOpenChange} open={open}>
      {Step ? (
        <Step flow={flow} onClose={() => onOpenChange(false)} worktreeName={worktreeName} />
      ) : null}
    </BottomSheet>
  );
}

/** What every step of the sheet is handed. */
interface StepProps {
  flow: CommitAndPr;
  /** Closes the sheet once the step's work is handed to the host. */
  onClose: () => void;
  worktreeName: string;
}

/**
 * The step shown in each phase. Publishing keeps the review step on screen, so
 * its edits survive the push; a running job has no step at all.
 */
const PHASE_STEPS: Record<CommitAndPrPhase, ComponentType<StepProps> | null> = {
  idle: ConfirmStep,
  running: null,
  review: ReviewStep,
  publishing: ReviewStep,
  failed: FailedStep,
};

/** The step's heading: where the run got to, or what to call it before there is one. */
function StepHeading({ job, fallback }: { job: AiJob | null; fallback: string }) {
  return (
    <Text className="text-lg font-semibold text-foreground">
      {job ? stageLabel(job) : fallback}
    </Text>
  );
}

/** What is about to happen, before anything happens. */
function ConfirmStep({ flow, onClose: onStarted }: StepProps) {
  const [starting, setStarting] = useState(false);
  if (flow.githubReady === false) return <SignedOutStep />;
  if (flow.hasChanges === false) return <NothingToCommitStep />;
  return (
    <View className="gap-3">
      <Text className="text-sm text-muted-foreground">
        Every uncommitted change in this worktree — including new files — is grouped into commits,
        then a pull request is drafted. Nothing is pushed yet: you review the text first.
      </Text>
      <Button
        disabled={starting}
        onPress={() => {
          setStarting(true);
          void flow
            .start()
            .then(() => {
              onStarted();
              return undefined;
            })
            .catch((error: unknown) => {
              hapticWarning();
              Alert.alert("Couldn't start", errorText(error, "The host could not start this run."));
            })
            .finally(() => setStarting(false));
        }}
      >
        <Text>{starting ? "Starting…" : "Commit and draft a PR"}</Text>
      </Button>
    </View>
  );
}

/**
 * What the flow needs before it will start anything.
 *
 * The run ends in a push and a pull request, so a host with no GitHub token can
 * only produce commits the user never asked for. Saying so here — before the
 * first tap — is the difference between a blocked button and three commits and
 * an error.
 */
function SignedOutStep() {
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">Sign in to GitHub first</Text>
      <Text className="text-sm text-muted-foreground">
        This host has no GitHub token, so a branch cannot be pushed or a pull request opened. Sign
        in from Pragma on the desktop, under Settings → GitHub, then come back.
      </Text>
    </View>
  );
}

/**
 * A worktree with nothing uncommitted. The desktop disables its Commit & PR
 * button on the same condition: there is no plan to make, and a run would
 * spend a model call to say so.
 */
function NothingToCommitStep() {
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold text-foreground">Nothing to commit</Text>
      <Text className="text-sm text-muted-foreground">
        Every change in this worktree is already committed. Make a change, or open a pull request
        for the commits that are on the branch from the desktop.
      </Text>
    </View>
  );
}

/** The draft, editable, with the one button that publishes. */
function ReviewStep({ flow, onClose: onDone, worktreeName }: StepProps) {
  // The host's draft is the value until the user types over it. Held as
  // "what the user changed" rather than copied into state on arrival, so the
  // draft can land after the sheet opens without an effect racing the edits.
  const [edits, setEdits] = useState<{ title?: string; body?: string }>({});
  const [draft, setDraft] = useState(false);
  // Null means "whatever the repository defaults to": the host resolves that,
  // and the list may still be loading when the user publishes.
  const [base, setBase] = useState<string | null>(null);
  const { job } = flow;
  const title = draftText(edits.title, job?.title);
  const body = draftText(edits.body, job?.body);

  return (
    <View className="gap-1">
      <StepHeading fallback="Ready" job={job} />
      <Text className="text-sm text-muted-foreground">
        Review the pull request before it is pushed.
      </Text>
      <View className="mt-4">
        <BaseBranchPicker flow={flow} onChange={setBase} value={base} worktreeName={worktreeName} />
      </View>
      <ScrollView className="mt-3 max-h-72" keyboardShouldPersistTaps="handled">
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
      <ReviewActions
        canPublish={title.trim().length > 0}
        draft={draft}
        onPublish={() => publishReviewed(flow, { title: title.trim(), body, draft, base }, onDone)}
        onToggleDraft={() => setDraft((value) => !value)}
        publishing={flow.phase === "publishing"}
      />
    </View>
  );
}

/** The user's edit, else the host's draft, else empty. */
function draftText(edit: string | undefined, fromHost: string | null | undefined): string {
  return edit ?? fromHost ?? "";
}

/** The draft toggle and the button that pushes and opens the pull request. */
function ReviewActions({
  canPublish,
  draft,
  onPublish,
  onToggleDraft,
  publishing,
}: {
  canPublish: boolean;
  draft: boolean;
  onPublish: () => void;
  onToggleDraft: () => void;
  publishing: boolean;
}) {
  return (
    <View className="mt-4 gap-3">
      <Button onPress={onToggleDraft} variant="outline">
        <Text>{draft ? "Open as draft ✓" : "Open as draft"}</Text>
      </Button>
      <Button disabled={publishing || !canPublish} onPress={onPublish}>
        <Text>{publishing ? "Pushing…" : "Push & create PR"}</Text>
      </Button>
    </View>
  );
}

/** Publishes the reviewed text, closing the sheet on success and explaining a failure. */
function publishReviewed(
  flow: CommitAndPr,
  input: { title: string; body: string; draft: boolean; base: string | null },
  onDone: () => void,
): void {
  const { base, ...text } = input;
  void flow
    .publish({ ...text, ...(base ? { base } : {}) })
    .then(() => {
      hapticSuccess();
      onDone();
      return undefined;
    })
    .catch((error: unknown) => {
      hapticWarning();
      Alert.alert(
        "Couldn't publish",
        errorText(error, "The branch could not be pushed or the pull request created."),
      );
    });
}

/**
 * Which branch the pull request merges into, and which one it comes from.
 *
 * The same row the desktop shows above the title: base on the left, an arrow,
 * then the head as a read-only chip. The worktree's own branch is never offered
 * as a base — it is the head, and GitHub rejects a pull request from a branch
 * into itself. A failed listing is a tappable retry rather than a menu that
 * opens empty, and the publish button never waits on either.
 */
function BaseBranchPicker({
  flow,
  onChange,
  value,
  worktreeName,
}: {
  flow: CommitAndPr;
  onChange: (base: string) => void;
  value: string | null;
  worktreeName: string;
}) {
  const colors = useThemeColors();
  const branches = flow.branches;
  const selected = value ?? defaultBase(branches);
  const actions: MenuAction[] = baseBranchChoices(branches).map((branch) => ({
    id: branch,
    title: branch,
    state: branch === selected ? "on" : "off",
  }));
  const trigger = (
    <View className="h-9 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md border border-input bg-background px-2.5">
      <Text className="min-w-0 flex-1 font-mono text-xs text-foreground" numberOfLines={1}>
        {selected ?? branchListState(flow.branchesError)}
      </Text>
      <IconSymbol
        color={colors.mutedForeground}
        fallback="⌄"
        name="chevron.up.chevron.down"
        size={14}
      />
    </View>
  );
  return (
    <View className="flex-row items-center gap-2">
      {actions.length === 0 ? (
        <Pressable className="min-w-0 flex-1 flex-row" onPress={flow.refreshBranches}>
          {trigger}
        </Pressable>
      ) : (
        <MenuView
          actions={actions}
          onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
          style={{ flex: 1 }}
          title="Merge into"
        >
          {trigger}
        </MenuView>
      )}
      <IconSymbol color={colors.mutedForeground} fallback="←" name="arrow.left" size={14} />
      <Text
        className="min-w-0 flex-1 rounded bg-muted px-1.5 py-1 font-mono text-xs text-muted-foreground"
        numberOfLines={1}
      >
        {worktreeName}
      </Text>
    </View>
  );
}

function defaultBase(branches: GitHubBranches | null): string | null {
  return branches?.defaultBranch ?? null;
}

/** What the picker says before there is a branch to show. */
function branchListState(error: string | null): string {
  return error ? "Couldn't load — tap to retry" : "Loading…";
}

/**
 * A run that did not finish.
 *
 * It always reports what was committed anyway: after a failure partway through,
 * "three commits were made" is the difference between looking for lost work and
 * knowing exactly where it is.
 */
function FailedStep({ flow }: StepProps) {
  const { job } = flow;
  return (
    <View className="gap-1">
      <StepHeading fallback="Failed" job={job} />
      <Text className="text-sm text-muted-foreground">{failureReason(job)}</Text>
      <CommittedNote count={job?.commitCount ?? 0} />
      <View className="mt-5">
        <Button onPress={flow.reset} variant="outline">
          <Text>Start over</Text>
        </Button>
      </View>
    </View>
  );
}

function failureReason(job: AiJob | null): string {
  return job?.error ?? "The run did not finish.";
}

/** What a failed run committed anyway; nothing when it committed nothing. */
function CommittedNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Text className="mt-2 text-sm text-foreground">
      {count === 1
        ? "1 commit was already made and is still on your branch."
        : `${count} commits were already made and are still on your branch.`}
    </Text>
  );
}
