import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AnimatePresence, LayoutGroup } from "motion/react";

import { constants } from "@pragma-sh/constants";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Plus } from "lucide-react";

import { AgentLauncher } from "@/components/agents/AgentsMenu";
import {
  type MiniDestination,
  MiniLocationMenu,
  type MiniProjectCatalog,
} from "@/components/mini/MiniLocationMenu";
import {
  createMiniTab,
  initialMiniTabsState,
  type MiniLocation,
  type MiniTab,
  miniTabsReducer,
} from "@/components/mini/mini-tabs";
import { useMiniAgentStatus } from "@/components/mini/use-mini-agent-status";
import { useHomeDir } from "@/components/mini/use-mini-catalog";
import { activeTabLayoutIdFor, TabChip } from "@/components/tabs/TabChip";
import { useTabRenameState } from "@/components/tabs/use-tab-rename";
import { TerminalView } from "@/components/terminal/TerminalView";
import { IconButton } from "@/components/ui/icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { startAgentInTab } from "@/lib/agent-launch";
import { isMacPlatform } from "@/lib/platform";
import { type AgentConfig, onMenuAction, ptyKill } from "@/lib/tauri";
import { terminalManager } from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";
import { startWindowDrag } from "@/lib/window-drag";

const HOME: MiniLocation = { kind: "home" };
const noop = () => {};

/** Ends a tab's shell for good: its xterm, then its server session. */
function endSession(tabId: string): Promise<void> {
  terminalManager.dispose(tabId);
  return ptyKill(tabId).catch(() => undefined);
}

/**
 * A Pragma Mini window: a plain terminal window with the workspace's tab chrome.
 * Every new tab opens in the home directory; a tab's context menu moves it into
 * any project worktree (or back home) by restarting its shell there. Closing the
 * last tab closes the window. Nothing here is persisted: when the window goes
 * away (or the app quits) the desktop kills its sessions (`MiniSessions` in
 * `src-tauri/src/mini_window.rs`).
 *
 * `onActiveProjectChange` reports the active tab's project so the window's
 * plugins and theme follow it.
 */
export function MiniWindow({
  catalog,
  onActiveProjectChange,
  onCatalogStale,
}: {
  catalog: MiniProjectCatalog;
  onActiveProjectChange: (projectId: string | null) => void;
  /** Asks for a fresh project list (a tab's context menu just opened). */
  onCatalogStale: () => void;
}) {
  const [state, dispatch] = useReducer(miniTabsReducer, initialMiniTabsState);
  const homeDir = useHomeDir();
  const { tabs, activeTabId } = state;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activateTab = useCallback((tabId: string) => dispatch({ type: "activate", tabId }), []);
  useMiniAgentStatus(tabs, activeTabId, activateTab);

  const activeProjectId = activeTab?.location.kind === "worktree" ? activeTab.projectId : null;
  useEffect(() => onActiveProjectChange(activeProjectId), [activeProjectId, onActiveProjectChange]);

  const openTab = useCallback((): MiniTab | null => {
    if (!homeDir) return null;
    const tab = createMiniTab(HOME, homeDir);
    dispatch({ type: "open", tab });
    return tab;
  }, [homeDir]);

  const closeTab = useCallback((tabId: string) => {
    void endSession(tabId);
    dispatch({ type: "close", tabId });
    if (tabsRef.current.every((tab) => tab.id === tabId)) {
      void getCurrentWindow().close();
    }
  }, []);

  const relocateTab = useCallback((tab: MiniTab, destination: MiniDestination) => {
    const next = createMiniTab(destination.location, destination.cwd);
    void endSession(tab.id);
    dispatch({ type: "replace", tabId: tab.id, tab: next });
  }, []);

  const launchAgent = useCallback(
    (agent: AgentConfig) => {
      const tab = openTab();
      if (!tab) return;
      dispatch({ type: "agent", tabId: tab.id, agentId: agent.id, title: agent.name });
      startAgentInTab(tab.id, agent);
    },
    [openTab],
  );

  // The first tab, as soon as the home directory is known.
  const opened = useRef(false);
  useEffect(() => {
    if (homeDir && !opened.current) {
      opened.current = true;
      openTab();
    }
  }, [homeDir, openTab]);

  useTabLifecycle(tabs, dispatch, closeTab);

  useEffect(() => {
    if (activeTabId) terminalManager.focus(activeTabId);
  }, [activeTabId]);

  const activeIdRef = useRef(activeTabId);
  activeIdRef.current = activeTabId;
  useEffect(() => {
    const unlisten = onMenuAction((action) => {
      if (action === "tabs.new-terminal") openTab();
      if (action === "tabs.close-active" && activeIdRef.current) closeTab(activeIdRef.current);
    });
    return () => void unlisten.then((stop) => stop());
  }, [openTab, closeTab]);

  useShortcuts({
    projectId: activeProjectId,
    projectCount: 0,
    onProject: noop,
    worktreeCount: 0,
    onWorktree: noop,
    tabCount: tabs.length,
    onTab: (index) => {
      const tab = tabsRef.current[index];
      if (tab) dispatch({ type: "activate", tabId: tab.id });
    },
    onNextTab: () => dispatch({ type: "cycle", delta: 1 }),
    onPreviousTab: () => dispatch({ type: "cycle", delta: -1 }),
    onCloseTopTab: () => activeIdRef.current && closeTab(activeIdRef.current),
    onNewTerminalTab: () => void openTab(),
    onNewBrowserTab: noop,
    onNewWhiteboard: noop,
    onClearTerminal: () => activeIdRef.current && terminalManager.clear(activeIdRef.current),
    onBrowserReload: noop,
    onBrowserDevtools: noop,
    onBrowserCopyUrl: noop,
    onSplitHorizontal: noop,
    onSplitVertical: noop,
    onDeleteSelectedFile: noop,
    onScrollTerminalBottom: () =>
      activeIdRef.current && terminalManager.scrollToBottom(activeIdRef.current),
    onOpenCommandPalette: noop,
    onOpenCommandMode: noop,
    onOpenSettings: noop,
  });

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-content bg-canvas text-foreground flex h-screen flex-col overflow-hidden">
        <MiniTitleBar
          activeTabId={activeTabId}
          catalog={catalog}
          dispatch={dispatch}
          homeDir={homeDir}
          onClose={closeTab}
          onCatalogStale={onCatalogStale}
          onLaunchAgent={launchAgent}
          onNewTab={() => void openTab()}
          onRelocate={relocateTab}
          tabs={tabs}
        />
        <section aria-label="Terminal" className="bg-canvas relative min-h-0 flex-1">
          {tabs.map((tab) => (
            <div
              className={cn("absolute inset-0", tab.id !== activeTabId && "invisible")}
              key={tab.id}
            >
              <TerminalView active={tab.id === activeTabId} cwd={tab.cwd} tab={tab} />
            </div>
          ))}
        </section>
      </div>
    </TooltipProvider>
  );
}

/**
 * The single titlebar row: traffic-light clearance, the agent launcher, the
 * tab strip, and the new-tab button. Empty space drags the window.
 */
function MiniTitleBar({
  tabs,
  activeTabId,
  catalog,
  homeDir,
  dispatch,
  onClose,
  onRelocate,
  onNewTab,
  onLaunchAgent,
  onCatalogStale,
}: {
  tabs: MiniTab[];
  activeTabId: string | null;
  catalog: MiniProjectCatalog;
  homeDir: string | null;
  dispatch: (action: Parameters<typeof miniTabsReducer>[1]) => void;
  onClose: (tabId: string) => void;
  onRelocate: (tab: MiniTab, destination: MiniDestination) => void;
  onNewTab: () => void;
  onLaunchAgent: (agent: AgentConfig) => void;
  onCatalogStale: () => void;
}) {
  const rename = useTabRenameState(
    useCallback(
      (tabId: string, title: string) => dispatch({ type: "rename", tabId, title }),
      [dispatch],
    ),
  );
  const layoutId = useMemo(() => activeTabLayoutIdFor(tabs), [tabs]);
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent
    <header
      className={cn(
        "bg-sidebar text-muted-foreground flex shrink-0 items-center gap-2 border-b border-sidebar-border px-2",
        isMacPlatform() && "pl-20",
      )}
      onMouseDown={startWindowDrag}
      style={{ height: constants.window.titlebarHeight + 6 }}
    >
      <div className="shrink-0">
        <AgentLauncher disabled={!homeDir} onLaunch={onLaunchAgent} />
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the strip's empty space also drags the window */}
      <div
        className="flex min-w-0 flex-1 items-center overflow-x-auto"
        onMouseDown={startWindowDrag}
      >
        <LayoutGroup id="mini-tabs">
          <AnimatePresence initial={false}>
            {tabs.map((tab) => (
              <TabChip
                active={tab.id === activeTabId}
                activeTabLayoutId={layoutId}
                key={tab.id}
                menuItems={
                  <MiniLocationMenu
                    catalog={catalog}
                    homeDir={homeDir}
                    onOpen={onCatalogStale}
                    onSelect={(destination) => onRelocate(tab, destination)}
                    tab={tab}
                  />
                }
                onClose={() => onClose(tab.id)}
                onSelect={() => dispatch({ type: "activate", tabId: tab.id })}
                rename={rename}
                tab={tab}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>
      <IconButton
        className="shrink-0"
        disabled={!homeDir}
        label="New tab"
        onClick={onNewTab}
        size="icon-sm"
        variant="ghost"
      >
        <Plus />
      </IconButton>
    </header>
  );
}

/** Shell titles retitle their tab; a shell that exits closes its tab. */
function useTabLifecycle(
  tabs: MiniTab[],
  dispatch: (action: Parameters<typeof miniTabsReducer>[1]) => void,
  closeTab: (tabId: string) => void,
): void {
  const ids = tabs.map((tab) => tab.id).join("\n");
  useEffect(() => {
    const stops = ids
      .split("\n")
      .filter(Boolean)
      .flatMap((tabId) => [
        terminalManager.onTitle(tabId, (title) => dispatch({ type: "shell-title", tabId, title })),
        terminalManager.onExit(tabId, () => closeTab(tabId)),
      ]);
    return () => {
      for (const stop of stops) stop();
    };
  }, [ids, dispatch, closeTab]);
}
