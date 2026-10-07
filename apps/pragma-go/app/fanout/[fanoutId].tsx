import type { Fanout, FanoutMember } from "@pragma-sh/constants";
import {
  canActOnFanout,
  isActiveFanout,
  memberLabel,
  orderedMembers,
} from "@pragma-sh/fanout-view";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type ColorValue,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { composerKeyboardOffset } from "@/components/chat/Composer";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AttemptHeader, AttemptPage } from "@/components/fanout/AttemptPage";
import { FanoutComposer } from "@/components/fanout/FanoutComposer";
import { IconSymbol } from "@/components/IconSymbol";
import { Button } from "@/components/ui/button";
import { MenuView } from "@/components/ui/menu-view";
import { Text } from "@/components/ui/text";
import { useProjectRootPath, useWorktree } from "@/lib/data/data-context";
import { isCleanPick } from "@/lib/fanout-form";
import { fanoutOutcome, memberDotStatus } from "@/lib/fanout-status";
import { useFanout, useFanouts } from "@/lib/fanouts-context";
import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import { useCatalog } from "@/lib/use-catalog";
import { useFanoutActions } from "@/lib/use-fanout-actions";
import { useViewedProjectRoot } from "@/lib/use-viewed-project";
import { cn } from "@/lib/utils";
import { worktreeLabel } from "@/lib/worktree-tree";

/**
 * A fanout's compare view on a phone: one page per attempt, swiped between.
 *
 * The desktop lays attempts side by side, which a phone cannot; paging keeps
 * each attempt full width and readable end to end. The attempt in view heads
 * the screen — its agent, status, and the chat/retry/pick buttons — with a chip
 * row under it to jump straight to another. The follow-up composer stays below
 * the pager so a message can go to every attempt — or just the one in view —
 * without leaving.
 */
export default function FanoutScreen() {
  const { fanoutId } = useLocalSearchParams<{ fanoutId: string }>();
  const fanout = useFanout(fanoutId);
  useViewedProjectRoot(useProjectRootPath(fanout?.projectId));

  if (!fanout) return <MissingFanout />;
  if (!isActiveFanout(fanout)) return <FinishedFanout fanout={fanout} />;
  return <ActiveFanout fanout={fanout} />;
}

/** Waiting for the stream's first snapshot, or a fanout the host no longer has. */
function MissingFanout() {
  const { loaded } = useFanouts();
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <Stack.Screen options={{ title: "Fanout" }} />
      {loaded ? (
        <Text className="text-center text-muted-foreground">
          This fanout is no longer on the host.
        </Text>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}

function ActiveFanout({ fanout }: { fanout: Fanout }) {
  const members = useMemo(() => orderedMembers(fanout), [fanout]);
  const { width } = useWindowDimensions();
  const catalog = useCatalog();
  const colors = useThemeColors();
  const actions = useFanoutActions(fanout);
  const pager = useRef<FlatList<FanoutMember>>(null);
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const current = members[Math.min(index, members.length - 1)];
  const acting = canActOnFanout(fanout);

  const jumpTo = (next: number): void => {
    hapticSelection();
    setIndex(next);
    pager.current?.scrollToIndex({ index: next, animated: true });
  };
  const onPageSettled = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(width, 1));
    if (next !== index) setIndex(next);
  };

  const renderMenu = useCallback(
    ({ tintColor }: { tintColor?: ColorValue }) => (
      <MenuView
        actions={[{ id: "cancel", title: "Cancel fanout", attributes: { destructive: true } }]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "cancel") actions.cancel();
        }}
      >
        <IconSymbol
          color={tintColor ?? colors.foreground}
          fallback="⋯"
          name="ellipsis.circle"
          size={22}
        />
      </MenuView>
    ),
    [actions, colors.foreground],
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-background"
      keyboardVerticalOffset={composerKeyboardOffset}
    >
      <SafeAreaView className="flex-1" edges={["bottom"]}>
        <Stack.Screen
          options={{ title: fanout.title, headerRight: acting ? renderMenu : undefined }}
        />
        {current ? (
          <AttemptHeader
            busy={actions.busy}
            catalog={catalog}
            fanout={fanout}
            member={current}
            onPick={(member) =>
              actions.pick(member, (result) => {
                // Only a pick that removed every attempt worktree has nothing
                // left to show here. One that stopped with survivors stays
                // put, so tapping pick again can finish the cleanup.
                if (isCleanPick(result) && router.canGoBack()) router.back();
              })
            }
            onRetry={actions.retry}
          />
        ) : null}
        <AttemptChips current={index} members={members} onSelect={jumpTo} />
        {fanout.failure ? (
          <Text className="px-4 pb-1 text-sm text-destructive">{fanout.failure.message}</Text>
        ) : null}
        <FlatList
          data={members}
          getItemLayout={(_data, itemIndex) => ({
            length: width,
            offset: width * itemIndex,
            index: itemIndex,
          })}
          horizontal
          keyExtractor={(member) => member.id}
          onMomentumScrollEnd={onPageSettled}
          pagingEnabled
          ref={pager}
          renderItem={({ item, index: itemIndex }) => (
            <AttemptPage
              active={focused && itemIndex === index}
              fanout={fanout}
              member={item}
              width={width}
            />
          )}
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
        />
        <FanoutComposer
          current={current}
          disabled={!acting}
          onSend={actions.send}
          sending={actions.busy?.kind === "send"}
        />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/** One chip per attempt, in creation order; the pager follows the selection. */
function AttemptChips({
  current,
  members,
  onSelect,
}: {
  current: number;
  members: FanoutMember[];
  onSelect: (index: number) => void;
}) {
  return (
    <ScrollView
      contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 6 }}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
    >
      {members.map((member, index) => {
        const selected = index === current;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={cn(
              "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
              selected ? "border-primary bg-primary" : "border-border bg-card",
            )}
            key={member.id}
            onPress={() => onSelect(index)}
          >
            <AgentStatusDot status={memberDotStatus(member)} />
            <Text
              className={cn("text-sm", selected ? "text-primary-foreground" : "text-foreground")}
              numberOfLines={1}
            >
              {memberLabel(member)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * A fanout that has finished. Its attempt worktrees are gone (or released), so
 * there is nothing to page through; say how it ended and offer the parent.
 */
function FinishedFanout({ fanout }: { fanout: Fanout }) {
  const parent = useWorktree(fanout.parentWorktreeId);
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background px-8">
      <Stack.Screen options={{ title: fanout.title }} />
      <Text className="text-center text-foreground">{fanoutOutcome(fanout)}</Text>
      {parent ? (
        <Button
          onPress={() =>
            router.push({
              pathname: "/worktree/[worktreeId]",
              params: { worktreeId: fanout.parentWorktreeId },
            })
          }
          variant="outline"
        >
          <Text>Open {worktreeLabel(parent)}</Text>
        </Button>
      ) : null}
    </View>
  );
}
