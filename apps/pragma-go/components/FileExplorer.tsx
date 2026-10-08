import type { DirEntry } from "@pragma-sh/constants";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { useConnection } from "@/lib/connection-context";
import {
  ROOT_PATH,
  toggleExpanded,
  visibleFileRows,
  type DirListing,
  type FileTreeRow,
} from "@/lib/file-tree";
import { hapticSelection } from "@/lib/haptics";
import { reportUnauthorized } from "@/lib/report-unauthorized";
import { useThemeColors } from "@/lib/theme";
import { IconSymbol } from "./IconSymbol";
import { NavGroup } from "./NavRow";
import { Text } from "./ui/text";

/** Horizontal step per nesting level, matching the desktop tree's density. */
const INDENT_PX = 14;

/**
 * The worktree's files, browsed like the desktop's Files tab and opened
 * read-only.
 *
 * Folders list lazily, one host call per first expansion, and stay cached so
 * collapsing and re-expanding is instant. Returning to the screen re-reads the
 * root and every open folder — an agent may have written files meanwhile —
 * keeping the old listing on screen until the new one lands. There are no
 * create, rename, move, or delete actions: on a phone this is a viewer.
 */
export function FileExplorer({ root, worktreeId }: { root: string; worktreeId: string }) {
  const { client, handleUnauthorized } = useConnection();
  const [listings, setListings] = useState<Map<string, DirListing>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Paths with a listing request in flight, so a re-render never doubles one.
  const inFlight = useRef(new Set<string>());
  // Bumped when the tree is swapped out; a response from the previous worktree
  // must not land in the new one's listings.
  const generation = useRef(0);

  const load = useCallback(
    (path: string) => {
      if (!client || inFlight.current.has(path)) return;
      const at = generation.current;
      inFlight.current.add(path);
      setListings((current) =>
        current.has(path) ? current : new Map(current).set(path, { kind: "loading" }),
      );
      client.fs
        .listDir({ root, path })
        .then((entries) => {
          if (generation.current !== at) return;
          setListings((current) => new Map(current).set(path, { kind: "ready", entries }));
          return undefined;
        })
        .catch((error: unknown) => {
          if (generation.current !== at) return;
          reportUnauthorized(error, handleUnauthorized);
          const message = error instanceof Error ? error.message : "Couldn't list this folder.";
          setListings((current) => new Map(current).set(path, { kind: "error", message }));
        })
        .finally(() => {
          if (generation.current === at) inFlight.current.delete(path);
        });
    },
    [client, handleUnauthorized, root],
  );

  // A different worktree (or host) is a different tree: start over.
  useEffect(() => {
    generation.current += 1;
    setListings(new Map());
    setExpanded(new Set());
    inFlight.current.clear();
  }, [client, root]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useFocusEffect(
    useCallback(() => {
      load(ROOT_PATH);
      for (const path of expandedRef.current) load(path);
    }, [load]),
  );

  const toggle = useCallback(
    (path: string) => {
      hapticSelection();
      setExpanded((current) => toggleExpanded(current, path));
      if (!listings.has(path)) load(path);
    },
    [listings, load],
  );

  const rows = useMemo(() => visibleFileRows(listings, expanded), [expanded, listings]);

  return (
    <NavGroup title="Files">
      {rows.map((row) => (
        <FileRow
          key={row.kind === "entry" ? row.entry.path : row.key}
          onOpenFile={(path) =>
            router.push({ pathname: "/file/[worktreeId]", params: { worktreeId, path } })
          }
          onToggle={toggle}
          row={row}
        />
      ))}
    </NavGroup>
  );
}

function FileRow({
  onOpenFile,
  onToggle,
  row,
}: {
  onOpenFile: (path: string) => void;
  onToggle: (path: string) => void;
  row: FileTreeRow;
}) {
  const paddingLeft = 12 + row.depth * INDENT_PX;
  if (row.kind === "status") {
    return (
      <Text
        className="py-2 pr-4 text-sm text-muted-foreground"
        style={{ paddingLeft: paddingLeft + 18 }}
      >
        {row.text}
      </Text>
    );
  }
  if (row.entry.isDir) {
    return (
      <FolderRow
        entry={row.entry}
        expanded={row.expanded}
        onToggle={onToggle}
        paddingLeft={paddingLeft}
      />
    );
  }
  return <FileLeafRow entry={row.entry} onOpenFile={onOpenFile} paddingLeft={paddingLeft} />;
}

/** A folder: disclosure chevron, folder icon, name; tapping expands it in place. */
function FolderRow({
  entry,
  expanded,
  onToggle,
  paddingLeft,
}: {
  entry: DirEntry;
  expanded: boolean;
  onToggle: (path: string) => void;
  paddingLeft: number;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityLabel={`${entry.name}, folder`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      className="flex-row items-center gap-2 py-2 pr-4 active:bg-accent"
      onPress={() => onToggle(entry.path)}
      style={{ paddingLeft }}
    >
      <View className="w-3 items-center">
        <IconSymbol
          color={colors.mutedForeground}
          fallback={expanded ? "▾" : "▸"}
          name={expanded ? "chevron.down" : "chevron.right"}
          size={11}
        />
      </View>
      <IconSymbol color={colors.foreground} fallback="📁" name="folder.fill" size={16} />
      <EntryName name={entry.name} />
    </Pressable>
  );
}

/** A file: icon and name; tapping opens it in the read-only viewer. */
function FileLeafRow({
  entry,
  onOpenFile,
  paddingLeft,
}: {
  entry: DirEntry;
  onOpenFile: (path: string) => void;
  paddingLeft: number;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityLabel={entry.name}
      accessibilityRole="button"
      className="flex-row items-center gap-2 py-2 pr-4 active:bg-accent"
      onPress={() => onOpenFile(entry.path)}
      style={{ paddingLeft }}
    >
      {/* Keeps file names aligned with folder names beside the chevron column. */}
      <View className="w-3" />
      <IconSymbol color={colors.mutedForeground} fallback="📄" name="doc.text" size={16} />
      <EntryName name={entry.name} />
    </Pressable>
  );
}

function EntryName({ name }: { name: string }) {
  return (
    <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
      {name}
    </Text>
  );
}
