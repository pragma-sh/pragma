import type { Fanout, FanoutMember, ScratchpadFile, Tab } from "@pragma/constants";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PickImplementationDialog } from "@/components/fanout/PickImplementationDialog";
import { TerminalView } from "@/components/terminal/TerminalView";
import { Button } from "@/components/ui/button";
import {
  MIN_COLUMN_WIDTH,
  memberLabel,
  memberTooltip,
  orderedMembers,
  pairScratchpads,
  resizeColumn,
  unionChangedPaths,
  type ScratchpadRow,
} from "@/lib/fanout";
import type { WorktreeChanges } from "@pragma/constants";
import { listScratchpadFiles, openScratchpadTab, worktreeChangesSince } from "@/lib/tauri";
import { useFanouts } from "@/state/fanouts-context";
import { useWorkspace } from "@/state/workspace-context";

import { FanoutDiffCell } from "./FanoutDiffCell";

/**
 * Side-by-side comparison of a fanout's attempts.
 *
 * Replaces the centre workspace and the right sidebar rather than overlaying
 * them: attempt terminals are real xterm hosts, and native browser webviews
 * float above HTML, so an overlay would be clipped.
 *
 * One shared column model drives the sticky header and every section row.
 * Independent resizable groups per row drift apart the moment a row collapses.
 */
export function FanoutComparison({ fanout }: { fanout: Fanout }) {
  const fanouts = useFanouts();
  const members = useMemo(
    () => orderedMembers(fanout).filter((member) => member.worktreeId),
    [fanout],
  );
  const [picking, setPicking] = useState<string | null>(null);
  const memberCount = members.length;

  // Measure the scroll viewport so columns divide its width evenly instead of
  // overflowing at a fixed width.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(width > 0 ? width : null);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // A drag overrides the equal split; a retry that adds or drops a column drops
  // back to the auto split so every section keeps spanning the full tab width.
  const [explicitWidths, setExplicitWidths] = useState<number[] | null>(null);
  useEffect(() => setExplicitWidths(null), [memberCount]);

  const equalWidth = useMemo(
    () =>
      containerWidth === null || memberCount === 0
        ? null
        : Math.max(MIN_COLUMN_WIDTH, Math.floor(containerWidth / memberCount)),
    [containerWidth, memberCount],
  );

  const widths = useMemo(() => {
    if (explicitWidths) return explicitWidths;
    if (equalWidth === null) return members.map(() => DEFAULT_COLUMN_WIDTH);
    return Array.from({ length: memberCount }, () => equalWidth);
  }, [explicitWidths, equalWidth, memberCount, members]);

  const template = widths.map((width) => `${width}px`).join(" ");

  const handleResize = useCallback(
    (index: number, delta: number) => {
      setExplicitWidths((current) => resizeColumn(current ?? widths, index, delta));
    },
    [widths],
  );

  return (
    <section className="bg-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
        <span className="truncate text-sm font-medium">
          Compare implementations · {fanout.title}
        </span>
        <Button size="sm" variant="ghost" onClick={fanouts.closeComparison}>
          <X className="size-3.5" />
          Exit compare
        </Button>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-max">
          <AttemptHeader
            members={members}
            template={template}
            widths={widths}
            onPick={setPicking}
            onResize={handleResize}
          />
          <ScratchpadSection fanout={fanout} members={members} template={template} />
          <SessionSection members={members} template={template} />
          <CodeSection fanout={fanout} members={members} template={template} />
        </div>
      </div>
      {picking ? (
        <PickImplementationDialog
          fanout={fanout}
          memberId={picking}
          open
          onOpenChange={(open) => !open && setPicking(null)}
        />
      ) : null}
    </section>
  );
}

/** Starting width of a comparison column. */
const DEFAULT_COLUMN_WIDTH = 480;

/** Sticky attempt headers: harness, model, reasoning, member id, status. */
function AttemptHeader({
  members,
  template,
  widths,
  onResize,
  onPick,
}: {
  members: FanoutMember[];
  template: string;
  widths: number[];
  onResize: (index: number, deltaPx: number) => void;
  onPick: (memberId: string) => void;
}) {
  return (
    <div
      className="sticky top-0 z-10 grid border-b border-border bg-card"
      style={{ gridTemplateColumns: template }}
    >
      {members.map((member, index) => (
        <div key={member.id} className="relative min-w-0 border-r border-border px-3 py-2">
          <div className="truncate text-sm font-medium" title={memberTooltip(member)}>
            {memberLabel(member)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {member.reasoningId ?? "auto"} · {member.id} · {member.status}
          </div>
          <Button className="mt-1" size="sm" variant="outline" onClick={() => onPick(member.id)}>
            Pick this implementation
          </Button>
          {index < members.length - 1 ? (
            <ColumnSeparator
              width={widths[index] ?? MIN_COLUMN_WIDTH}
              onResize={(delta) => onResize(index, delta)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Drag handle on a header boundary; updates the one shared column model. */
function ColumnSeparator({
  width,
  onResize,
}: {
  width: number;
  onResize: (deltaPx: number) => void;
}) {
  const originRef = useRef<number | null>(null);
  return (
    <hr
      aria-label="Resize column"
      aria-valuenow={width}
      className="absolute inset-y-0 right-0 m-0 w-1 cursor-col-resize border-0 bg-transparent hover:bg-border"
      onPointerDown={(event) => {
        originRef.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (originRef.current === null) return;
        const delta = event.clientX - originRef.current;
        originRef.current = event.clientX;
        onResize(delta);
      }}
      onPointerUp={() => {
        originRef.current = null;
      }}
    />
  );
}

/** A collapsible section heading with an expand/collapse-all control. */
function SectionHeader({
  title,
  collapsed,
  onToggle,
  onToggleAll,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  onToggleAll?: (expanded: boolean) => void;
}) {
  const Caret = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="sticky left-0 flex items-center gap-2 bg-muted px-3 py-1.5 text-sm font-medium">
      <button className="flex items-center gap-1" type="button" onClick={onToggle}>
        <Caret className="size-3.5" />
        {title}
      </button>
      {onToggleAll ? (
        <span className="ml-auto flex gap-2 text-xs font-normal text-muted-foreground">
          <button type="button" onClick={() => onToggleAll(true)}>
            Expand all
          </button>
          <button type="button" onClick={() => onToggleAll(false)}>
            Collapse all
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** Scratchpads, paired across attempts. */
function ScratchpadSection({
  fanout,
  members,
  template,
}: {
  fanout: Fanout;
  members: FanoutMember[];
  template: string;
}) {
  const workspace = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [rows, setRows] = useState<ScratchpadRow[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Re-read when the member set changes; file edits arrive on the next open.
  const worktreeKey = members.map((member) => member.worktreeId).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      members.map(async (member) => {
        const files = await listScratchpadFiles(member.worktreeId!).catch(
          () => [] as ScratchpadFile[],
        );
        return [member.id, files] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setRows(pairScratchpads(new Map(entries)));
        return entries;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fanout.id, members, worktreeKey]);

  return (
    <section className="border-b border-border">
      <SectionHeader
        collapsed={collapsed}
        title={`Scratchpads · ${rows.length}`}
        onToggle={() => setCollapsed((value) => !value)}
        onToggleAll={(open) => setExpanded(Object.fromEntries(rows.map((row) => [row.key, open])))}
      />
      {collapsed
        ? null
        : rows.map((row) => {
            const open = expanded[row.key] ?? true;
            return (
              <div key={row.key}>
                <button
                  className="sticky left-0 flex w-full items-center gap-1 px-4 py-1 text-left text-xs text-muted-foreground"
                  type="button"
                  onClick={() => setExpanded((current) => ({ ...current, [row.key]: !open }))}
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {row.title}
                </button>
                {open ? (
                  <div className="grid" style={{ gridTemplateColumns: template }}>
                    {members.map((member) => {
                      const file = row.byMember[member.id];
                      return (
                        <div key={member.id} className="min-w-0 border-r border-border p-2 text-xs">
                          {file ? (
                            <button
                              className="w-full whitespace-pre-wrap text-left font-mono"
                              type="button"
                              onClick={() => {
                                // Editing happens in the attempt itself, in the
                                // ordinary scratchpad editor.
                                void workspace.selectWorktree(member.worktreeId!);
                                void openScratchpadTab(
                                  member.worktreeId!,
                                  file.filePath,
                                  file.title,
                                );
                              }}
                            >
                              {file.contents}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">No matching scratchpad</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
    </section>
  );
}

/**
 * Live agent sessions.
 *
 * Each cell mounts the real {@link TerminalView} for the attempt's tab: input,
 * scroll, resize, and status all behave as they do anywhere else. Collapsing a
 * row unmounts the host, which parks the terminal through the terminal manager
 * and releases its renderer — it never kills the PTY.
 */
function SessionSection({ members, template }: { members: FanoutMember[]; template: string }) {
  const workspace = useWorkspace();
  const worktreePath = useCallback(
    (worktreeId: string) =>
      Object.values(workspace.worktrees)
        .flat()
        .find((worktree) => worktree.id === worktreeId)?.path ?? "",
    [workspace.worktrees],
  );
  const [collapsed, setCollapsed] = useState(false);
  const [focused, setFocused] = useState<string | null>(members[0]?.id ?? null);

  const tabFor = useCallback(
    (member: FanoutMember): Tab | null =>
      workspace.projectTabs.find((tab) => tab.id === member.tabId) ?? null,
    [workspace.projectTabs],
  );

  return (
    <section className="border-b border-border">
      <SectionHeader
        collapsed={collapsed}
        title="Agent sessions"
        onToggle={() => setCollapsed((value) => !value)}
      />
      {collapsed ? null : (
        <div className="grid" style={{ gridTemplateColumns: template }}>
          {members.map((member) => {
            const tab = tabFor(member);
            return (
              <fieldset
                key={member.id}
                className={`h-96 min-w-0 border-r border-border ${
                  focused === member.id ? "ring-1 ring-inset ring-ring" : ""
                }`}
                onFocusCapture={() => setFocused(member.id)}
              >
                {tab ? (
                  <TerminalView
                    active={focused === member.id}
                    cwd={worktreePath(member.worktreeId!)}
                    tab={tab}
                  />
                ) : (
                  <p className="p-3 text-xs text-muted-foreground">
                    This attempt has no live session. Retry it to start one.
                  </p>
                )}
              </fieldset>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Code changes, diffed against the fanout's captured base commit. */
function CodeSection({
  fanout,
  members,
  template,
}: {
  fanout: Fanout;
  members: FanoutMember[];
  template: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [pathsByMember, setPathsByMember] = useState<Map<string, string[]>>(new Map());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const worktreeKey = members.map((member) => member.worktreeId).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      members.map(async (member) => {
        const changes = await worktreeChangesSince(member.worktreeId!, fanout.baseCommit).catch(
          () => null,
        );
        return [member.id, changedPaths(changes)] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setPathsByMember(new Map(entries));
        return entries;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fanout.baseCommit, members, worktreeKey]);

  const paths = useMemo(() => unionChangedPaths(pathsByMember), [pathsByMember]);

  return (
    <section>
      <SectionHeader
        collapsed={collapsed}
        title={`Code · ${paths.length} file${paths.length === 1 ? "" : "s"}`}
        onToggle={() => setCollapsed((value) => !value)}
        onToggleAll={(open) => setExpanded(Object.fromEntries(paths.map((path) => [path, open])))}
      />
      {collapsed
        ? null
        : paths.map((path) => {
            // Diffs are mounted only while expanded: N attempts × one CodeMirror
            // pane per file is otherwise an expensive way to render nothing.
            const open = expanded[path] ?? true;
            return (
              <div key={path} className="border-t border-border">
                <button
                  className="sticky left-0 flex w-full items-center gap-1 px-4 py-1 text-left text-xs font-mono"
                  type="button"
                  onClick={() => setExpanded((current) => ({ ...current, [path]: !open }))}
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {path}
                </button>
                {open ? (
                  <div className="grid" style={{ gridTemplateColumns: template }}>
                    {members.map((member) => (
                      <div key={member.id} className="h-96 min-w-0 border-r border-border">
                        {pathsByMember.get(member.id)?.includes(path) ? (
                          <FanoutDiffCell
                            base={fanout.baseCommit}
                            path={path}
                            worktreeId={member.worktreeId!}
                          />
                        ) : (
                          <p className="p-2 text-xs text-muted-foreground">Unchanged</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
    </section>
  );
}

/** Every path a worktree touched, committed, staged, or unstaged. */
function changedPaths(changes: WorktreeChanges | null): string[] {
  if (!changes) return [];
  return [...changes.committed, ...changes.staged, ...changes.unstaged].map((file) => file.path);
}
