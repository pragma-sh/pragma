import * as Linking from "expo-linking";
import { useEffect, useMemo, useRef } from "react";

import { useConnection } from "../connection-context";
import { useAllAgentTabs, useInbox, useProjects, useWorktrees } from "../data/data-context";
import { buildWidgetSnapshot, type WidgetLinks, type WidgetSnapshot } from "./widget-data";
import { pragmaWidgets } from "./widgets";

/**
 * WidgetKit budgets reloads, and agent status can change many times a second
 * while a session streams. Coalesce bursts into at most one push per interval.
 */
const MIN_PUSH_INTERVAL_MS = 15_000;

/**
 * Mirrors the live workspace into the iOS home-screen widgets. A widget cannot
 * reach the host itself — the extension only renders the last snapshot the app
 * pushed — so this runs for as long as the app is alive and re-pushes whenever
 * the derived content actually changes.
 */
export function useWidgetSync(): void {
  const { status } = useConnection();
  const paired = status === "paired";
  const projects = useProjects();
  const worktrees = useWorktrees();
  const agentTabs = useAllAgentTabs();
  const { items } = useInbox();

  const links = useMemo<WidgetLinks>(
    () => ({
      inbox: Linking.createURL("/inbox"),
      project: (projectId: string) => Linking.createURL(`/project/${projectId}`),
      worktree: (worktreeId: string) => Linking.createURL(`/worktree/${worktreeId}`),
    }),
    [],
  );

  // Built with `now: 0` so the timestamp does not make every render look like a
  // content change; the real timestamp is stamped at push time.
  const content = useMemo(
    () =>
      buildWidgetSnapshot({
        paired,
        projects,
        worktrees,
        agentTabs,
        inbox: items,
        links,
        now: 0,
      }),
    [agentTabs, items, links, paired, projects, worktrees],
  );
  const signature = useMemo(() => JSON.stringify(content), [content]);

  const lastPushedAt = useRef(0);

  useEffect(() => {
    const elapsed = Date.now() - lastPushedAt.current;
    if (elapsed >= MIN_PUSH_INTERVAL_MS) {
      lastPushedAt.current = Date.now();
      pushWidgetSnapshot(content);
      return undefined;
    }
    const timeout = setTimeout(() => {
      lastPushedAt.current = Date.now();
      pushWidgetSnapshot(content);
    }, MIN_PUSH_INTERVAL_MS - elapsed);
    return () => clearTimeout(timeout);
    // `signature` is the content identity; `content` is read at push time.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

/** Fans one snapshot out to every widget's timeline. Silent off iOS. */
function pushWidgetSnapshot(snapshot: WidgetSnapshot): void {
  const widgets = pragmaWidgets();
  if (!widgets) return;
  const { paired, counts, inbox, inboxTotal, projects, inboxUrl } = snapshot;
  const updatedAt = Date.now();
  widgets.attention.updateSnapshot({ paired, attention: counts.attention, url: inboxUrl });
  widgets.agents.updateSnapshot({ paired, updatedAt, ...counts, url: inboxUrl });
  widgets.inbox.updateSnapshot({
    paired,
    updatedAt,
    items: inbox,
    total: inboxTotal,
    url: inboxUrl,
  });
  widgets.projects.updateSnapshot({ paired, updatedAt, projects, url: inboxUrl });
}
