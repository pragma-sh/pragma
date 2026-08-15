import {
  markAllResolved,
  unresolvedComments,
  unresolvedCommentsPrompt,
} from "@pragma/scratchpad-viewer";
import type { ScratchpadBlock, ScratchpadFile } from "@pragma/sdk";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IconSymbol } from "@/components/IconSymbol";
import { WorktreeBackButton } from "@/components/WorktreeBackButton";
import { AttachAgentDrawer } from "@/components/scratchpad/AttachAgentDrawer";
import { CommentComposerSheet } from "@/components/scratchpad/CommentComposerSheet";
import { ScratchpadLoading } from "@/components/scratchpad/ScratchpadLoading";
import { ScratchpadWebView } from "@/components/scratchpad/ScratchpadWebView";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { hapticImpact, hapticSelection, hapticSuccess, hapticWarning } from "@/lib/haptics";
import { useScratchpadAgent } from "@/lib/use-scratchpad-agent";
import { useScratchpadComments } from "@/lib/use-scratchpad-comments";
import { useScratchpad } from "@/lib/use-scratchpads";
import { errorText } from "@/lib/utils";
import { useThemeColors } from "@/lib/theme";

/**
 * One scratchpad, read-only, with a touch comment layer.
 *
 * The document renders in a web view (`@pragma/scratchpad-viewer`), so
 * interactive blocks behave as they do on the desktop. Everything around it is
 * native: tap or press and hold a block to comment on it, then submit the open
 * comments to the attached agent in one message — the same handoff the desktop's
 * "Resolve comments" button sends.
 */
export default function ScratchpadScreen() {
  const { worktreeId, filePath, title } = useLocalSearchParams<{
    scratchpadId: string;
    worktreeId: string;
    filePath: string;
    title: string;
  }>();
  const { scratchpad, root, loading, reload } = useScratchpad(worktreeId, filePath);
  const { foreground } = useThemeColors();

  return (
    <>
      <Stack.Screen
        options={{
          title: scratchpad?.title ?? title,
          // oxlint-disable-next-line react/no-unstable-nested-components -- React Navigation header render callback.
          headerLeft: ({ tintColor }) => (
            <WorktreeBackButton color={tintColor ?? foreground} worktreeId={worktreeId} />
          ),
        }}
      />
      {scratchpad ? (
        <ScratchpadContent
          onReload={reload}
          root={root}
          scratchpad={scratchpad}
          worktreeId={worktreeId}
        />
      ) : (
        <ScratchpadPlaceholder loading={loading} />
      )}
    </>
  );
}

/** Shown while the host serves the file, and when the file has left the worktree. */
function ScratchpadPlaceholder({ loading }: { loading: boolean }) {
  if (loading) return <ScratchpadLoading label="Loading scratchpad…" />;
  return (
    <View className="flex-1 items-center justify-center bg-background p-8">
      <Text className="text-center text-muted-foreground">
        This scratchpad is no longer in the worktree.
      </Text>
    </View>
  );
}

function ScratchpadContent({
  onReload,
  root,
  scratchpad,
  worktreeId,
}: {
  onReload: () => void;
  root: string | undefined;
  scratchpad: ScratchpadFile;
  worktreeId: string;
}) {
  const insets = useSafeAreaInsets();
  const { foreground } = useThemeColors();
  const { add, comments, loaded, save } = useScratchpadComments(root, scratchpad.filePath);
  const agent = useScratchpadAgent(scratchpad, worktreeId, root, onReload);
  const [commentMode, setCommentMode] = useState(false);
  const [picked, setPicked] = useState<ScratchpadBlock | null>(null);
  const [sending, setSending] = useState(false);

  const open = unresolvedComments(comments);

  const submitComments = useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      const sent = (await agent.promptAgent(unresolvedCommentsPrompt(open))) === "sent";
      if (sent) {
        await save(markAllResolved(comments, Date.now()));
        setCommentMode(false);
      }
      sentFeedback(sent);
    } catch (cause) {
      hapticWarning();
      Alert.alert("Couldn't send comments", errorText(cause));
    } finally {
      setSending(false);
    }
  }, [agent, comments, open, save]);

  // The sheet stays open until the host has taken the comment: clearing the
  // block first would throw the typed text away on a failed write, and leave
  // the rejected promise unhandled.
  const addComment = useCallback(
    async (text: string): Promise<void> => {
      if (!picked) return;
      try {
        await add(picked, text);
      } catch (cause) {
        hapticWarning();
        Alert.alert("Couldn't add comment", errorText(cause));
        return;
      }
      setPicked(null);
      hapticSuccess();
    },
    [add, picked],
  );

  const renderCommentModeButton = useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <CommentModeButton
        active={commentMode}
        color={tintColor}
        disabled={!loaded}
        onToggle={() => {
          hapticImpact();
          setCommentMode((active) => !active);
        }}
      />
    ),
    [commentMode, loaded],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: scratchpad.title,
          headerRight: renderCommentModeButton,
          // oxlint-disable-next-line react/no-unstable-nested-components -- React Navigation header render callback.
          headerLeft: ({ tintColor }) => (
            <WorktreeBackButton color={tintColor ?? foreground} worktreeId={worktreeId} />
          ),
        }}
      />
      <View className="flex-1 bg-background">
        <ScratchpadWebView
          commentMode={commentMode}
          comments={comments}
          onError={() => undefined}
          onPreview={previewFeedback}
          onPromptAgent={agent.promptAgent}
          onRequestAttachment={agent.requestAttachment}
          onSelect={setPicked}
          source={scratchpad.contents}
        />
        <ScratchpadFooter
          commentMode={commentMode}
          insetBottom={insets.bottom}
          onSubmit={() => void submitComments()}
          openCount={open.length}
          sending={sending}
        />
      </View>
      <CommentComposerSheet
        block={picked}
        onCancel={() => setPicked(null)}
        onSubmit={(text) => void addComment(text)}
      />
      <AttachAgentDrawer
        agentTabs={agent.agentTabs}
        attachedTabId={agent.attachedTab?.id ?? null}
        onAttach={(tab) => void agent.attach(tab)}
        onClose={() => agent.closeDrawer(false)}
        open={agent.attachOpen}
      />
    </>
  );
}

/** Header toggle that hands the document over to the comment picker. */
function CommentModeButton({
  active,
  color,
  disabled,
  onToggle,
}: {
  active: boolean;
  color?: ColorValue;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button disabled={disabled} onPress={onToggle} size="icon" variant="ghost">
      <IconSymbol
        color={color}
        fallback={active ? "✕" : "💬"}
        name={active ? "xmark.circle" : "bubble.left.and.text.bubble.right"}
        size={22}
      />
    </Button>
  );
}

/**
 * The bar under the document: what comment mode expects of the reader and how
 * many comments are waiting. Attachment is not offered here — sending opens the
 * attach drawer only when the scratchpad has no agent yet.
 */
function ScratchpadFooter({
  commentMode,
  insetBottom,
  onSubmit,
  openCount,
  sending,
}: {
  commentMode: boolean;
  insetBottom: number;
  onSubmit: () => void;
  openCount: number;
  sending: boolean;
}) {
  if (!commentMode && openCount === 0) return null;
  return (
    <View
      className="border-t border-border bg-card px-4 pt-3"
      style={{ paddingBottom: insetBottom + 12 }}
    >
      <CommentModeHint show={commentMode} />
      <Button disabled={sending || openCount === 0} onPress={onSubmit}>
        <Text>{submitLabel(openCount)}</Text>
      </Button>
    </View>
  );
}

/** Tells the reader what the picker expects while comment mode is on. */
function CommentModeHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Text className="mb-3 text-center text-sm text-muted-foreground">
      Tap a block to comment, or press and hold to preview where it lands.
    </Text>
  );
}

/** A block coming under a long press ticks; leaving one is silent. */
function previewFeedback(block: ScratchpadBlock | null): void {
  if (block) hapticSelection();
}

function sentFeedback(sent: boolean): void {
  if (sent) hapticSuccess();
  else hapticWarning();
}

function submitLabel(openCount: number): string {
  if (openCount === 0) return "No comments yet";
  return `Send ${openCount} comment${openCount === 1 ? "" : "s"}`;
}
