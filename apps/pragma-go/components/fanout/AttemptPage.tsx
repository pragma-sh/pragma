import type { Fanout, FanoutMember } from "@pragma-sh/constants";
import {
  canActOnFanout,
  changedFiles,
  memberLabel,
  memberStatusLabel,
  type ChangedFileSummary,
} from "@pragma-sh/fanout-view";
import type { ScratchpadFile } from "@pragma-sh/sdk";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentStatusDot } from "@/components/AgentStatusDot";
import { IconSymbol } from "@/components/IconSymbol";
import { NavRow } from "@/components/NavRow";
import { ScratchpadWebView } from "@/components/scratchpad/ScratchpadWebView";
import { Button } from "@/components/ui/button";
import { MenuView } from "@/components/ui/menu-view";
import { Text } from "@/components/ui/text";
import { useWorktree } from "@/lib/data/data-context";
import { attemptScratchpads, memberDotStatus } from "@/lib/fanout-status";
import { useThemeColors } from "@/lib/theme";
import type { FanoutBusy } from "@/lib/use-fanout-actions";
import { catalogAgentById, type useCatalog } from "@/lib/use-catalog";
import { useHostValue, type HostClient } from "@/lib/use-host-value";
import { useWhiteboardSnapshotLoader } from "@/lib/use-whiteboard-snapshot";
import { cn } from "@/lib/utils";

/** How often a working attempt's scratchpads and changes are re-read while in view. */
const LIVE_REFRESH_MS = 5_000;
/** Tallest the expanded changed-file list grows before it scrolls. */
const FILE_LIST_MAX_HEIGHT = 240;

/**
 * One attempt: who it is and how it is doing, then the scratchpad it wrote —
 * rendered, filling the page — and a one-line summary of the files it changed
 * that expands into the list.
 *
 * The scratchpad is the attempt's answer; a TUI agent's terminal tail is mostly
 * chrome, so it is not shown here. "Open chat" goes to the live session.
 */
export function AttemptPage({
  active,
  busy,
  catalog,
  fanout,
  member,
  onPick,
  onRetry,
  width,
}: {
  /** This page is the one in view, on a focused screen; only it refreshes. */
  active: boolean;
  busy: FanoutBusy | null;
  catalog: ReturnType<typeof useCatalog>;
  fanout: Fanout;
  member: FanoutMember;
  onPick: (member: FanoutMember) => void;
  onRetry: (member: FanoutMember) => void;
  width: number;
}) {
  const data = useAttemptData(fanout, member, active);
  return (
    <View className="flex-1 gap-3 px-4 pb-2 pt-1" style={{ width }}>
      <AttemptHeader
        actionable={canActOnFanout(fanout) && !!member.worktreeId}
        busy={busy}
        catalog={catalog}
        member={member}
        onPick={onPick}
        onRetry={onRetry}
      />
      {member.failure ? (
        <Text className="text-sm text-destructive">{member.failure.message}</Text>
      ) : null}
      <AttemptScratchpad
        loading={data.scratchpadsLoading}
        member={member}
        scratchpads={data.scratchpads}
      />
      <ChangedFiles
        base={fanout.baseCommit}
        files={data.files}
        label={memberLabel(member)}
        loading={data.changesLoading}
        worktreeId={member.worktreeId}
      />
    </View>
  );
}

/** Everything an attempt page reads from the host, refreshed while it is live. */
function useAttemptData(fanout: Fanout, member: FanoutMember, active: boolean) {
  const root = useAttemptRoot(member.worktreeId);
  const changes = useHostValue(
    root ? `${root}\0${fanout.baseCommit}` : null,
    readChanges(root, fanout.baseCommit),
  );
  const scratchpads = useHostValue(root, readScratchpads(root));
  useLiveRefresh(active && isWorking(member), [scratchpads.reload, changes.reload]);
  const ordered = useMemo(
    () => attemptScratchpads(scratchpads.value ?? [], member.tabId),
    [member.tabId, scratchpads.value],
  );
  return {
    files: changedFiles(changes.value ?? null),
    changesLoading: changes.loading && !changes.value,
    scratchpads: ordered,
    scratchpadsLoading: scratchpads.loading && !scratchpads.value,
  };
}

/** The attempt worktree's host path, or null until the workspace knows it. */
function useAttemptRoot(worktreeId: string | null): string | null {
  const worktree = useWorktree(worktreeId ?? "");
  return worktree ? worktree.path : null;
}

function readChanges(root: string | null, base: string) {
  const at = root ?? "";
  return (client: HostClient) => client.git.changesSinceCommit({ root: at, base });
}

function readScratchpads(root: string | null) {
  const at = root ?? "";
  return (client: HostClient) => client.scratchpads.getScratchpads({ root: at });
}

function isWorking(member: FanoutMember): boolean {
  return (
    member.status === "pending" ||
    member.status === "provisioning" ||
    member.status === "running" ||
    member.status === "attention"
  );
}

/** Re-runs every reload on an interval while `live`. */
function useLiveRefresh(live: boolean, reloads: Array<() => void>): void {
  // Held in a ref so a fresh array each render does not restart the timer.
  const latest = useRef(reloads);
  latest.current = reloads;
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => {
      for (const reload of latest.current) reload();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live]);
}

/** Icon, name, status, and the actions — one row. Retry lives in the overflow menu. */
function AttemptHeader({
  actionable,
  busy,
  catalog,
  member,
  onPick,
  onRetry,
}: {
  actionable: boolean;
  busy: FanoutBusy | null;
  catalog: ReturnType<typeof useCatalog>;
  member: FanoutMember;
  onPick: (member: FanoutMember) => void;
  onRetry: (member: FanoutMember) => void;
}) {
  const colors = useThemeColors();
  const picking = busy?.kind === "pick" && busy.memberId === member.id;
  const retrying = busy?.kind === "retry" && busy.memberId === member.id;
  return (
    <View className="flex-row items-center gap-2.5">
      <AgentIcon
        fallback="◆"
        icon={catalogAgentById(catalog, member.catalogAgentId)?.icon}
        size={24}
      />
      <View className="min-w-0 flex-1">
        <Text className="font-semibold" numberOfLines={1}>
          {memberLabel(member)}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <AgentStatusDot status={memberDotStatus(member)} />
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {retrying ? "Retrying…" : memberStatusLabel(member)}
          </Text>
        </View>
      </View>
      <ChatButton color={colors.foreground} member={member} />
      {actionable ? (
        <>
          <MenuView
            actions={[{ id: "retry", title: "Retry attempt" }]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "retry" && busy === null) onRetry(member);
            }}
          >
            <IconSymbol color={colors.foreground} fallback="⋯" name="ellipsis.circle" size={20} />
          </MenuView>
          <Button disabled={busy !== null} onPress={() => onPick(member)} size="sm">
            <Text>{picking ? "Picking…" : "Pick"}</Text>
          </Button>
        </>
      ) : null}
    </View>
  );
}

/** Opens the attempt's live session, when it has one. */
function ChatButton({ color, member }: { color: string; member: FanoutMember }) {
  const { tabId, worktreeId } = member;
  if (!tabId || !worktreeId) return null;
  return (
    <Pressable
      accessibilityLabel="Open chat"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() =>
        router.push({
          pathname: "/chat/[tabId]",
          params: { agent: member.runtimeAgentId, tabId, worktreeId },
        })
      }
    >
      <IconSymbol color={color} fallback="💬" name="bubble.left.and.text.bubble.right" size={20} />
    </Pressable>
  );
}

/** The attempt's scratchpad, rendered; a title row switches when it wrote several. */
function AttemptScratchpad({
  loading,
  member,
  scratchpads,
}: {
  loading: boolean;
  member: FanoutMember;
  scratchpads: ScratchpadFile[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    scratchpads.find((scratchpad) => scratchpad.id === selectedId) ?? scratchpads[0] ?? null;
  const { worktreeId } = member;
  if (!worktreeId || !selected) {
    return <ScratchpadEmpty loading={loading} member={member} />;
  }
  return (
    <View className="flex-1 overflow-hidden rounded-xl border border-border bg-card">
      <ScratchpadTabs
        onOpen={() => openScratchpad(selected, worktreeId)}
        onSelect={setSelectedId}
        scratchpads={scratchpads}
        selected={selected}
      />
      <InlineScratchpad scratchpad={selected} worktreeId={worktreeId} />
    </View>
  );
}

function ScratchpadEmpty({ loading, member }: { loading: boolean; member: FanoutMember }) {
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <View className="flex-1 items-center justify-center gap-1 rounded-xl border border-dashed border-border px-6">
      <Text className="text-center text-sm text-muted-foreground">
        {isWorking(member) ? "Working — no scratchpad yet." : "This attempt wrote no scratchpad."}
      </Text>
      {member.tabId ? (
        <Text className="text-center text-xs text-muted-foreground">
          Open the chat to see what it said.
        </Text>
      ) : null}
    </View>
  );
}

/** One tab per scratchpad (only when there are several), plus an expand button. */
function ScratchpadTabs({
  onOpen,
  onSelect,
  scratchpads,
  selected,
}: {
  onOpen: () => void;
  onSelect: (id: string) => void;
  scratchpads: ScratchpadFile[];
  selected: ScratchpadFile;
}) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center border-b border-border pr-2">
      <ScrollView
        contentContainerStyle={{ gap: 4, paddingHorizontal: 8, paddingVertical: 6 }}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
      >
        {scratchpads.map((scratchpad) => {
          const current = scratchpad.id === selected.id;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: current }}
              className={cn("rounded-md px-2 py-1", current && "bg-muted")}
              key={scratchpad.id}
              onPress={() => onSelect(scratchpad.id)}
            >
              <Text
                className={cn("text-xs", current ? "font-medium" : "text-muted-foreground")}
                numberOfLines={1}
              >
                {scratchpad.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable accessibilityLabel="Open scratchpad" hitSlop={8} onPress={onOpen}>
        <IconSymbol
          color={colors.mutedForeground}
          fallback="⤢"
          name="arrow.up.left.and.arrow.down.right"
          size={15}
        />
      </Pressable>
    </View>
  );
}

/** The read-only viewer; commenting and prompting live on the full scratchpad screen. */
function InlineScratchpad({
  scratchpad,
  worktreeId,
}: {
  scratchpad: ScratchpadFile;
  worktreeId: string;
}) {
  const loadWhiteboardSnapshot = useWhiteboardSnapshotLoader(worktreeId);
  return (
    <ScratchpadWebView
      commentMode={false}
      comments={NO_COMMENTS}
      onError={() => undefined}
      onGetWhiteboardSnapshot={loadWhiteboardSnapshot}
      onPreview={() => undefined}
      onPromptAgent={async () => "cancelled"}
      onRequestAttachment={async () => false}
      onSelect={() => openScratchpad(scratchpad, worktreeId)}
      source={scratchpad.contents}
    />
  );
}

const NO_COMMENTS: [] = [];

function openScratchpad(scratchpad: ScratchpadFile, worktreeId: string): void {
  router.push({
    pathname: "/scratchpad/[scratchpadId]",
    params: {
      scratchpadId: scratchpad.id,
      filePath: scratchpad.filePath,
      title: scratchpad.title,
      worktreeId,
    },
  });
}

/** `3 files changed  +40 −2`, tapping open into the per-file list. */
function ChangedFiles({
  base,
  files,
  label,
  loading,
  worktreeId,
}: {
  base: string;
  files: ChangedFileSummary[];
  label: string;
  loading: boolean;
  worktreeId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const colors = useThemeColors();
  if (!worktreeId) return null;
  const expandable = !loading && files.length > 0;
  return (
    <View className="overflow-hidden rounded-xl border border-border bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-2 px-3 py-2.5"
        disabled={!expandable}
        onPress={() => setOpen((value) => !value)}
      >
        <Text className="flex-1 text-sm">{changesTitle(files, loading)}</Text>
        {expandable ? (
          <>
            <ChangeTotals files={files} />
            <IconSymbol
              color={colors.mutedForeground}
              fallback={open ? "▾" : "▸"}
              name={open ? "chevron.down" : "chevron.right"}
              size={13}
            />
          </>
        ) : null}
      </Pressable>
      {open && expandable ? (
        <ScrollView className="border-t border-border" style={{ maxHeight: FILE_LIST_MAX_HEIGHT }}>
          {files.map((file) => (
            <NavRow
              key={file.path}
              onPress={() =>
                router.push({
                  pathname: "/diff/[worktreeId]",
                  params: { worktreeId, path: file.path, base, oldPath: file.oldPath ?? "", label },
                })
              }
              subtitle={changeSummary(file)}
              title={file.path}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function changesTitle(files: ChangedFileSummary[], loading: boolean): string {
  if (loading) return "Loading changes…";
  if (files.length === 0) return "No changes yet";
  return files.length === 1 ? "1 file changed" : `${files.length} files changed`;
}

function ChangeTotals({ files }: { files: ChangedFileSummary[] }) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return (
    <Text className="text-xs">
      <Text className="text-xs text-green-600">+{additions}</Text>{" "}
      <Text className="text-xs text-destructive">−{deletions}</Text>
    </Text>
  );
}

/** `modified · +12 −3`, or just the status when the counts are unknown (binary). */
function changeSummary(file: ChangedFileSummary): string {
  if (file.additions === null || file.deletions === null) return file.status;
  return `${file.status} · +${file.additions} −${file.deletions}`;
}
