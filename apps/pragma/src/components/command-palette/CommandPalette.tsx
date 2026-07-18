import {
  Fragment,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Code2,
  FileText,
  FolderGit2,
  GitPullRequest,
  MonitorUp,
  Network,
  SquareTerminal,
  Terminal,
} from "lucide-react";

import type { AgentStatus, PaletteSearchMatch, Tab, Worktree } from "@pragma/constants";

import { AgentIcon } from "@/components/agents/AgentIcon";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAgentsList } from "@/hooks/use-agents-list";
import { findPullRequestForBranch, type PullRequestSummary } from "@/lib/github";
import { useSuppressNativeOverlayWhile } from "@/lib/native-overlay";
import {
  cancelPaletteSearch,
  githubRepoRef,
  listWorktreeMru,
  paletteSearch,
  type OpenPort,
} from "@/lib/tauri";
import { useAgentStatusSnapshot } from "@/state/agent-status-store";
import { useGitHub } from "@/state/github-context";
import { useKanban } from "@/state/kanban-context";
import { useOpenPorts } from "@/state/open-ports-context";
import { useRightSidebar } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import { CommandMode } from "./CommandMode";
import { rankPaletteItems } from "./palette-ranking";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "search" | "command";
}

interface PalettePullRequest {
  worktreeId: string;
  pullRequest: PullRequestSummary;
}

const AGENT_LABELS: Record<Exclude<AgentStatus, "cleared">, string> = {
  attention: "Needs attention",
  running: "In progress",
  done: "Finished",
};
const AGENT_ORDER = ["attention", "running", "done"] as const;

function worktreeLabel(worktree: Worktree | undefined): string {
  return worktree?.title || worktree?.branch || "Unknown worktree";
}

function tabLabel(tab: Tab | undefined): string {
  return tab?.title || tab?.filePath || tab?.kind || "Terminal";
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

type Workspace = ReturnType<typeof useWorkspace>;
type Agent = ReturnType<typeof useAgentsList>[number];
type AgentEntry = ReturnType<typeof useAgentStatusSnapshot>[number];
type RunningScript = Workspace["runningScripts"][number];

function clearWorktreeScope(
  event: React.KeyboardEvent<HTMLInputElement>,
  query: string,
  scopedWorktreeId: string | null,
  setScopedWorktreeId: React.Dispatch<React.SetStateAction<string | null>>,
): boolean {
  if (event.key !== "Backspace" || query !== "" || !scopedWorktreeId) return false;
  event.preventDefault();
  setScopedWorktreeId(null);
  return true;
}

function clearEditorSelection(
  event: React.KeyboardEvent<HTMLInputElement>,
  commandMode: boolean,
  commandQuery: string,
  selectedEditorId: string | null,
  setSelectedEditorId: React.Dispatch<React.SetStateAction<string | null>>,
): boolean {
  if (event.key !== "Backspace" || !commandMode || commandQuery !== "" || !selectedEditorId) {
    return false;
  }
  event.preventDefault();
  setSelectedEditorId(null);
  return true;
}

function closeSelectedTerminal(
  event: React.KeyboardEvent<HTMLInputElement>,
  commandMode: boolean,
  closeTab: Workspace["closeTab"],
  close: () => void,
) {
  if (event.key !== "Enter" || !event.shiftKey || commandMode) return;
  const selected = event.currentTarget
    .closest("[cmdk-root]")
    ?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"][data-close-tab-id]');
  const tabId = selected?.dataset.closeTabId;
  if (!tabId) return;
  event.preventDefault();
  event.stopPropagation();
  void closeTab(tabId);
  close();
}

interface ScopeResultsProps {
  scopedWorktreeId: string | null;
  activeWorktrees: Worktree[];
  runningScriptRows: RunningScript[];
  worktreeRows: Worktree[];
  worktreeById: Map<string, Worktree>;
  projectId: string | null;
  activateTabLocation: Workspace["activateTabLocation"];
  goToScopedWorktree: () => void;
  selectScope: (worktreeId: string) => void;
  close: () => void;
}

function ScopeResults({
  scopedWorktreeId,
  activeWorktrees,
  runningScriptRows,
  worktreeRows,
  worktreeById,
  projectId,
  activateTabLocation,
  goToScopedWorktree,
  selectScope,
  close,
}: ScopeResultsProps) {
  return (
    <>
      {scopedWorktreeId ? (
        <CommandGroup heading="Scope">
          <CommandItem onSelect={goToScopedWorktree} value="go-to-scoped-worktree">
            <MonitorUp />
            <span>Go to worktree</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {worktreeLabel(activeWorktrees[0]!)}
            </span>
          </CommandItem>
        </CommandGroup>
      ) : null}
      {runningScriptRows.length > 0 ? (
        <CommandGroup heading="Running scripts">
          {runningScriptRows.map((script) => (
            <CommandItem
              data-close-tab-id={script.tabId}
              disabled={script.stopping}
              key={script.tabId}
              onSelect={() => {
                if (projectId) {
                  void activateTabLocation(projectId, script.worktreeId, script.tabId);
                }
                close();
              }}
              value={`running-script:${script.tabId}:${script.name}`}
            >
              <SquareTerminal />
              <span className="truncate">{script.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {worktreeLabel(worktreeById.get(script.worktreeId))}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {!scopedWorktreeId && worktreeRows.length > 0 ? (
        <CommandGroup heading="Worktrees">
          {worktreeRows.map((worktree) => (
            <CommandItem
              key={worktree.id}
              onSelect={() => selectScope(worktree.id)}
              value={`worktree:${worktree.id}`}
            >
              <FolderGit2 />
              <span>{worktreeLabel(worktree)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{worktree.branch}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </>
  );
}

function PortResults({
  rows,
  worktreeById,
  tabById,
  activateTab,
}: {
  rows: OpenPort[];
  worktreeById: Map<string, Worktree>;
  tabById: Map<string, Tab>;
  activateTab: (tab: Tab) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <CommandGroup heading="Ports">
      {rows.map((port) => {
        const tab = tabById.get(port.tabId);
        if (!tab) return null;
        return (
          <CommandItem
            data-close-tab-id={port.tabId}
            key={`${port.tabId}:${port.port}`}
            onSelect={() => activateTab(tab)}
            value={`port:${port.port}:${port.process}:${port.tabId}`}
          >
            <Network />
            <span className="font-mono tabular-nums">{port.port}</span>
            <span className="truncate">{port.process}</span>
            <span className="ml-auto min-w-0 truncate pl-4 text-xs text-muted-foreground">
              {tabLabel(tab)} · {worktreeLabel(worktreeById.get(port.worktreeId))}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function PullRequestResults({
  rows,
  openPullRequest,
}: {
  rows: PalettePullRequest[];
  openPullRequest: (row: PalettePullRequest) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <CommandGroup heading="Pull requests">
      {rows.map((row) => (
        <CommandItem
          key={`${row.worktreeId}:${row.pullRequest.number}`}
          onSelect={() => openPullRequest(row)}
          value={`pr:${row.worktreeId}:${row.pullRequest.number}`}
        >
          <GitPullRequest />
          <span>#{row.pullRequest.number}</span>
          <span className="truncate">{row.pullRequest.title}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

interface AgentResultsProps {
  rows: AgentEntry[];
  agentsById: Map<string, Agent>;
  projectId: string | null;
  projectTabs: Tab[];
  navigateToAgentLocation: Workspace["navigateToAgentLocation"];
  close: () => void;
}

function AgentResults({
  rows,
  agentsById,
  projectId,
  projectTabs,
  navigateToAgentLocation,
  close,
}: AgentResultsProps) {
  if (!AGENT_ORDER.some((status) => rows.some((row) => row.status === status))) return null;
  return (
    <CommandGroup heading="Agents">
      {AGENT_ORDER.map((status) => {
        const statusRows = rows.filter((row) => row.status === status).slice(0, 5);
        if (statusRows.length === 0) return null;
        return (
          <Fragment key={status}>
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
              {AGENT_LABELS[status]}
            </div>
            {statusRows.map((row) => {
              const agent = agentsById.get(row.agent);
              return (
                <CommandItem
                  key={`${row.worktreeId}:${row.tabId}:${row.agent}`}
                  onSelect={() => {
                    if (projectId) {
                      void navigateToAgentLocation?.(projectId, row.worktreeId, row.tabId);
                    }
                    close();
                  }}
                  value={`agent:${row.worktreeId}:${row.tabId}:${row.agent}`}
                >
                  {agent ? <AgentIcon agent={agent} /> : <Bot />}
                  <span>{row.agent}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {tabLabel(projectTabs.find((tab) => tab.id === row.tabId))}
                  </span>
                </CommandItem>
              );
            })}
          </Fragment>
        );
      })}
    </CommandGroup>
  );
}

interface FileResultsProps {
  openFileRows: Tab[];
  fileMatches: PaletteSearchMatch[];
  terminalRows: Tab[];
  worktreeById: Map<string, Worktree>;
  activateTab: (tab: Tab) => void;
  openFile: (match: PaletteSearchMatch) => void;
}

function FileResults({
  openFileRows,
  fileMatches,
  terminalRows,
  worktreeById,
  activateTab,
  openFile,
}: FileResultsProps) {
  return (
    <>
      {openFileRows.length > 0 ? (
        <CommandGroup heading="Open files">
          {openFileRows.map((tab) => (
            <CommandItem key={tab.id} onSelect={() => activateTab(tab)} value={`open:${tab.id}`}>
              <FileText />
              <span className="truncate">{tab.filePath}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {fileMatches.length > 0 ? (
        <CommandGroup heading="Files">
          {fileMatches.map((match) => (
            <CommandItem
              key={`file:${match.worktreeId}:${match.path}`}
              onSelect={() => openFile(match)}
              value={`file:${match.worktreeId}:${match.path}`}
            >
              <FileText />
              <span className="truncate">{fileName(match.path)}</span>
              <span className="ml-auto min-w-0 truncate pl-4 text-xs text-muted-foreground">
                {match.path} · {worktreeLabel(worktreeById.get(match.worktreeId))}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {terminalRows.length > 0 ? (
        <CommandGroup heading="Terminal tabs">
          {terminalRows.map((tab) => (
            <CommandItem
              key={tab.id}
              onSelect={() => activateTab(tab)}
              value={`terminal:${tab.id}`}
            >
              <Terminal />
              <span>{tabLabel(tab)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </>
  );
}

function CodeResults({
  codeMatches,
  hostError,
  deferredQuery,
  openFile,
}: {
  codeMatches: PaletteSearchMatch[];
  hostError: string | null;
  deferredQuery: string;
  openFile: (match: PaletteSearchMatch) => void;
}) {
  return (
    <>
      {codeMatches.length > 0 ? (
        <CommandGroup heading="Code">
          {codeMatches.map((match) => (
            <CommandItem
              key={`code:${match.worktreeId}:${match.path}:${match.line}`}
              onSelect={() => openFile(match)}
              value={`code:${match.worktreeId}:${match.path}:${match.line}`}
            >
              <Code2 />
              <span className="min-w-0">
                <span className="block truncate">
                  {match.path}:{match.line}
                </span>
                <code className="block truncate text-xs text-muted-foreground">
                  {match.snippet}
                </code>
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {hostError && deferredQuery ? (
        <div className="px-3 py-2 text-xs text-destructive">
          Files/code unavailable: {hostError}
        </div>
      ) : null}
    </>
  );
}

function useResetPaletteOnOpenChange(
  open: boolean,
  mode: CommandPaletteProps["mode"],
  setQuery: React.Dispatch<React.SetStateAction<string>>,
  setSelectedEditorId: React.Dispatch<React.SetStateAction<string | null>>,
  setScopedWorktreeId: React.Dispatch<React.SetStateAction<string | null>>,
  setHostMatches: React.Dispatch<React.SetStateAction<PaletteSearchMatch[]>>,
  setHostError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  useEffect(() => {
    if (open) {
      setQuery(mode === "command" ? ">" : "");
      return;
    }
    setQuery("");
    setSelectedEditorId(null);
    setScopedWorktreeId(null);
    setHostMatches([]);
    setHostError(null);
  }, [
    mode,
    open,
    setHostError,
    setHostMatches,
    setQuery,
    setScopedWorktreeId,
    setSelectedEditorId,
  ]);
}

function useClosePaletteOnProjectChange(
  projectId: string | null,
  onOpenChange: (open: boolean) => void,
) {
  const previousProjectRef = useRef(projectId);
  useEffect(() => {
    if (previousProjectRef.current !== projectId) {
      previousProjectRef.current = projectId;
      onOpenChange(false);
    }
  }, [onOpenChange, projectId]);
}

function useWorktreeMruLoading(
  open: boolean,
  projectId: string | null,
  setRecencyByWorktree: React.Dispatch<React.SetStateAction<Record<string, number>>>,
) {
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    void listWorktreeMru(projectId)
      .then((rows) => {
        if (!cancelled) {
          setRecencyByWorktree(
            Object.fromEntries(rows.map((row) => [row.worktreeId, row.lastUsedAt])),
          );
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, projectId, setRecencyByWorktree]);
}

function useHostPaletteSearch({
  commandMode,
  deferredQuery,
  generationRef,
  open,
  projectId,
  scopedWorktreeId,
  setHostError,
  setHostMatches,
}: {
  commandMode: boolean;
  deferredQuery: string;
  generationRef: React.MutableRefObject<number>;
  open: boolean;
  projectId: string | null;
  scopedWorktreeId: string | null;
  setHostError: React.Dispatch<React.SetStateAction<string | null>>;
  setHostMatches: React.Dispatch<React.SetStateAction<PaletteSearchMatch[]>>;
}) {
  useEffect(() => {
    if (!open || commandMode || !projectId || deferredQuery.trim().length === 0) {
      generationRef.current += 1;
      setHostMatches([]);
      setHostError(null);
      return;
    }
    const generation = ++generationRef.current;
    const searchId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      void paletteSearch(projectId, scopedWorktreeId, searchId, deferredQuery)
        .then((response) => {
          if (generation !== generationRef.current) return undefined;
          startTransition(() => {
            setHostMatches(response.matches);
            setHostError(null);
          });
          return undefined;
        })
        .catch((cause: unknown) => {
          if (generation !== generationRef.current) return;
          setHostMatches([]);
          setHostError(cause instanceof Error ? cause.message : String(cause));
          return undefined;
        });
    }, 100);
    return () => {
      generationRef.current += 1;
      window.clearTimeout(timer);
      void cancelPaletteSearch(projectId, searchId).catch(() => undefined);
    };
  }, [
    commandMode,
    deferredQuery,
    generationRef,
    open,
    projectId,
    scopedWorktreeId,
    setHostError,
    setHostMatches,
  ]);
}

function usePullRequestLoading(
  authenticated: boolean,
  open: boolean,
  visibleWorktrees: Worktree[],
  setPullRequests: React.Dispatch<React.SetStateAction<PalettePullRequest[]>>,
) {
  useEffect(() => {
    if (!open || !authenticated) {
      setPullRequests([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      visibleWorktrees.map(async (worktree): Promise<PalettePullRequest | null> => {
        try {
          const repo = await githubRepoRef(worktree.id);
          const pullRequest = await findPullRequestForBranch(repo);
          return pullRequest ? { worktreeId: worktree.id, pullRequest } : null;
        } catch {
          return null;
        }
      }),
    ).then((rows) => {
      if (!cancelled) setPullRequests(rows.filter((row) => row !== null));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated, open, setPullRequests, visibleWorktrees]);
}

function useScopeValidity(
  scopedWorktreeId: string | null,
  visibleWorktreeIds: Set<string>,
  setScopedWorktreeId: React.Dispatch<React.SetStateAction<string | null>>,
) {
  useEffect(() => {
    if (scopedWorktreeId && !visibleWorktreeIds.has(scopedWorktreeId)) {
      setScopedWorktreeId(null);
    }
  }, [scopedWorktreeId, setScopedWorktreeId, visibleWorktreeIds]);
}

function usePaletteSources() {
  const workspace = useWorkspace();
  const github = useGitHub();
  const kanban = useKanban();
  const rightSidebar = useRightSidebar();
  const agents = useAgentsList();
  const agentEntries = useAgentStatusSnapshot();
  const ports = useOpenPorts();
  return { workspace, github, kanban, rightSidebar, agents, agentEntries, ports };
}

function usePaletteState() {
  const [query, setQuery] = useState("");
  const [selectedEditorId, setSelectedEditorId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const [scopedWorktreeId, setScopedWorktreeId] = useState<string | null>(null);
  const [recencyByWorktree, setRecencyByWorktree] = useState<Record<string, number>>({});
  const [hostMatches, setHostMatches] = useState<PaletteSearchMatch[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [pullRequests, setPullRequests] = useState<PalettePullRequest[]>([]);
  const generationRef = useRef(0);
  return {
    query,
    setQuery,
    selectedEditorId,
    setSelectedEditorId,
    deferredQuery,
    scopedWorktreeId,
    setScopedWorktreeId,
    recencyByWorktree,
    setRecencyByWorktree,
    hostMatches,
    setHostMatches,
    hostError,
    setHostError,
    pullRequests,
    setPullRequests,
    generationRef,
  };
}

function usePaletteScope(workspace: Workspace, scopedWorktreeId: string | null) {
  const projectId = workspace.selectedProjectId;
  const visibleWorktrees = useMemo(
    () =>
      (projectId ? (workspace.worktrees[projectId] ?? []) : []).filter(
        (worktree) => !worktree.hidden,
      ),
    [projectId, workspace.worktrees],
  );
  const visibleWorktreeIds = useMemo(
    () => new Set(visibleWorktrees.map((worktree) => worktree.id)),
    [visibleWorktrees],
  );
  const activeWorktrees = scopedWorktreeId
    ? visibleWorktrees.filter((worktree) => worktree.id === scopedWorktreeId)
    : visibleWorktrees;
  const activeWorktreeIds = useMemo(
    () => new Set(activeWorktrees.map((worktree) => worktree.id)),
    [activeWorktrees],
  );
  const worktreeById = useMemo(
    () => new Map(visibleWorktrees.map((worktree) => [worktree.id, worktree])),
    [visibleWorktrees],
  );
  return {
    projectId,
    visibleWorktrees,
    visibleWorktreeIds,
    activeWorktrees,
    activeWorktreeIds,
    worktreeById,
  };
}

// fallow-ignore-next-line code-duplication -- param-destructuring shape shared with unrelated hooks (usePrSubmit, useWorkspaceListeners); not extractable logic.
function usePaletteAsyncData({
  open,
  mode,
  onOpenChange,
  authenticated,
  state,
  scope,
  commandMode,
}: {
  open: boolean;
  mode: CommandPaletteProps["mode"];
  onOpenChange: CommandPaletteProps["onOpenChange"];
  authenticated: boolean;
  state: ReturnType<typeof usePaletteState>;
  scope: ReturnType<typeof usePaletteScope>;
  commandMode: boolean;
}) {
  useResetPaletteOnOpenChange(
    open,
    mode,
    state.setQuery,
    state.setSelectedEditorId,
    state.setScopedWorktreeId,
    state.setHostMatches,
    state.setHostError,
  );
  useClosePaletteOnProjectChange(scope.projectId, onOpenChange);
  useWorktreeMruLoading(open, scope.projectId, state.setRecencyByWorktree);
  useHostPaletteSearch({
    commandMode,
    deferredQuery: state.deferredQuery,
    generationRef: state.generationRef,
    open,
    projectId: scope.projectId,
    scopedWorktreeId: state.scopedWorktreeId,
    setHostError: state.setHostError,
    setHostMatches: state.setHostMatches,
  });
  usePullRequestLoading(authenticated, open, scope.visibleWorktrees, state.setPullRequests);
  useScopeValidity(state.scopedWorktreeId, scope.visibleWorktreeIds, state.setScopedWorktreeId);
}

function usePaletteRows({
  workspace,
  agents,
  agentEntries,
  ports,
  state,
  scope,
}: {
  workspace: Workspace;
  agents: Agent[];
  agentEntries: AgentEntry[];
  ports: OpenPort[];
  state: ReturnType<typeof usePaletteState>;
  scope: ReturnType<typeof usePaletteScope>;
}) {
  const recency = (worktreeId: string) => state.recencyByWorktree[worktreeId] ?? 0;
  const worktreeRows = rankPaletteItems(
    scope.activeWorktrees,
    state.deferredQuery,
    (worktree) => [worktreeLabel(worktree), worktree.branch],
    (worktree) => recency(worktree.id),
    (worktree) => worktree.id,
  ).slice(0, state.deferredQuery ? 20 : 8);
  const terminalRows = rankPaletteItems(
    workspace.projectTabs.filter(
      (tab) => tab.kind === "terminal" && scope.activeWorktreeIds.has(tab.worktreeId),
    ),
    state.deferredQuery,
    (tab) => [tabLabel(tab)],
    (tab) => recency(tab.worktreeId),
    (tab) => tab.id,
  ).slice(0, 8);
  const runningScriptRows = rankPaletteItems(
    workspace.runningScripts.filter((script) => scope.activeWorktreeIds.has(script.worktreeId)),
    state.deferredQuery,
    (script) => [script.name, worktreeLabel(scope.worktreeById.get(script.worktreeId))],
    (script) => recency(script.worktreeId),
    (script) => script.tabId,
  ).slice(0, 8);
  const openFileRows = rankPaletteItems(
    workspace.projectTabs.filter(
      (tab) =>
        (tab.kind === "editor" || tab.kind === "diff") &&
        !!tab.filePath &&
        scope.activeWorktreeIds.has(tab.worktreeId),
    ),
    state.deferredQuery,
    (tab) => [tab.filePath ?? "", tabLabel(tab)],
    (tab) => recency(tab.worktreeId),
    (tab) => `${tab.worktreeId}:${tab.filePath}`,
  ).slice(0, 8);
  const agentRows = rankPaletteItems(
    agentEntries.filter(
      (entry) => entry.status !== "cleared" && scope.activeWorktreeIds.has(entry.worktreeId),
    ),
    state.deferredQuery,
    (entry) => [entry.agent, tabLabel(workspace.projectTabs.find((tab) => tab.id === entry.tabId))],
    (entry) => recency(entry.worktreeId),
    (entry) => `${entry.worktreeId}:${entry.tabId}:${entry.agent}`,
  );
  const prRows = rankPaletteItems(
    state.pullRequests.filter((row) => scope.activeWorktreeIds.has(row.worktreeId)),
    state.deferredQuery,
    (row) => [String(row.pullRequest.number), row.pullRequest.title, row.pullRequest.headRef],
    (row) => recency(row.worktreeId),
    (row) => `${row.worktreeId}:${row.pullRequest.number}`,
  ).slice(0, 6);
  const tabById = new Map(
    workspace.projectTabs.filter((tab) => tab.kind === "terminal").map((tab) => [tab.id, tab]),
  );
  const portRows = rankPaletteItems(
    ports.filter(
      (port) =>
        scope.activeWorktreeIds.has(port.worktreeId) &&
        tabById.get(port.tabId)?.worktreeId === port.worktreeId,
    ),
    state.deferredQuery,
    (port) => [String(port.port), port.process],
    (port) => recency(port.worktreeId),
    (port) => `${port.tabId}:${port.port}`,
  ).slice(0, 8);
  return {
    agentById: new Map(agents.map((agent) => [agent.id, agent])),
    worktreeRows,
    terminalRows,
    runningScriptRows,
    openFileRows,
    agentRows,
    prRows,
    portRows,
    tabById,
    fileMatches: state.hostMatches.filter((match) => match.kind === "file").slice(0, 20),
    codeMatches:
      state.deferredQuery.trim().length >= 2
        ? state.hostMatches.filter((match) => match.kind === "code").slice(0, 20)
        : [],
  };
}

function usePaletteActions({
  onOpenChange,
  workspace,
  kanban,
  rightSidebar,
  state,
  projectId,
  commandMode,
  commandQuery,
}: {
  onOpenChange: CommandPaletteProps["onOpenChange"];
  workspace: Workspace;
  kanban: ReturnType<typeof useKanban>;
  rightSidebar: ReturnType<typeof useRightSidebar>;
  state: ReturnType<typeof usePaletteState>;
  projectId: string | null;
  commandMode: boolean;
  commandQuery: string;
}) {
  const close = () => onOpenChange(false);
  const goToScopedWorktree = () => {
    if (state.scopedWorktreeId) workspace.selectWorktree(state.scopedWorktreeId);
    close();
  };
  const selectScope = (worktreeId: string) => {
    state.setScopedWorktreeId(worktreeId);
    state.setQuery("");
  };
  const activateTab = (tab: Tab) => {
    if (!projectId) return;
    void workspace.activateTabLocation(projectId, tab.worktreeId, tab.id);
    close();
  };
  const openFile = (match: PaletteSearchMatch) => {
    if (!projectId) return;
    void workspace.openFileLocation({
      projectId,
      worktreeId: match.worktreeId,
      path: match.path,
      line: match.line ?? undefined,
      column: match.column ?? undefined,
    });
    close();
  };
  const openPullRequest = (row: PalettePullRequest) => {
    kanban.exitBoard();
    workspace.selectWorktree(row.worktreeId);
    rightSidebar.setActiveSubtab("pullRequest");
    rightSidebar.setCollapsed(false);
    close();
  };
  const onEscapeKeyDown: NonNullable<
    React.ComponentProps<typeof CommandDialog>["onEscapeKeyDown"]
  > = (event) => {
    if (state.selectedEditorId) {
      event.preventDefault();
      state.setSelectedEditorId(null);
      state.setQuery(">");
      return;
    }
    if (state.scopedWorktreeId) {
      event.preventDefault();
      state.setScopedWorktreeId(null);
      state.setQuery("");
    }
  };
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (clearWorktreeScope(event, state.query, state.scopedWorktreeId, state.setScopedWorktreeId)) {
      return;
    }
    if (
      clearEditorSelection(
        event,
        commandMode,
        commandQuery,
        state.selectedEditorId,
        state.setSelectedEditorId,
      )
    ) {
      return;
    }
    closeSelectedTerminal(event, commandMode, workspace.closeTab, close);
  };
  return {
    close,
    goToScopedWorktree,
    selectScope,
    activateTab,
    openFile,
    openPullRequest,
    onEscapeKeyDown,
    onInputKeyDown,
  };
}

/** Project-scoped command palette spanning visible worktrees and async host sources. */
export function CommandPalette({ open, onOpenChange, mode }: CommandPaletteProps) {
  const { workspace, github, kanban, rightSidebar, agents, agentEntries, ports } =
    usePaletteSources();
  const state = usePaletteState();
  useSuppressNativeOverlayWhile(open);
  const scope = usePaletteScope(workspace, state.scopedWorktreeId);
  const commandMode = state.query.startsWith(">");
  const commandQuery = commandMode ? state.query.slice(1).trimStart() : "";
  usePaletteAsyncData({
    open,
    mode,
    onOpenChange,
    authenticated: github.authenticated,
    state,
    scope,
    commandMode,
  });
  const rows = usePaletteRows({ workspace, agents, agentEntries, ports, state, scope });
  const actions = usePaletteActions({
    onOpenChange,
    workspace,
    kanban,
    rightSidebar,
    state,
    projectId: scope.projectId,
    commandMode,
    commandQuery,
  });

  return (
    <CommandDialog
      open={open}
      onEscapeKeyDown={actions.onEscapeKeyDown}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl"
    >
      <Command shouldFilter={false}>
        <CommandInput
          onKeyDown={actions.onInputKeyDown}
          onValueChange={state.setQuery}
          placeholder={
            commandMode
              ? state.selectedEditorId
                ? "Search worktrees..."
                : "Search commands..."
              : "Search worktrees, ports, scripts, PRs, agents, files, terminals, code..."
          }
          value={state.query}
        />
        {commandMode ? (
          <CommandMode
            close={actions.close}
            query={commandQuery}
            recencyByWorktree={state.recencyByWorktree}
            selectedEditorId={state.selectedEditorId}
            setQuery={state.setQuery}
            setSelectedEditorId={state.setSelectedEditorId}
            worktrees={scope.visibleWorktrees}
          />
        ) : (
          <CommandList className="max-h-[min(60vh,32rem)]">
            <CommandEmpty>No matching project results.</CommandEmpty>
            <ScopeResults
              activateTabLocation={workspace.activateTabLocation}
              activeWorktrees={scope.activeWorktrees}
              close={actions.close}
              goToScopedWorktree={actions.goToScopedWorktree}
              projectId={scope.projectId}
              runningScriptRows={rows.runningScriptRows}
              scopedWorktreeId={state.scopedWorktreeId}
              selectScope={actions.selectScope}
              worktreeById={scope.worktreeById}
              worktreeRows={rows.worktreeRows}
            />
            <PullRequestResults openPullRequest={actions.openPullRequest} rows={rows.prRows} />
            <PortResults
              activateTab={actions.activateTab}
              rows={rows.portRows}
              tabById={rows.tabById}
              worktreeById={scope.worktreeById}
            />
            <AgentResults
              agentsById={rows.agentById}
              close={actions.close}
              navigateToAgentLocation={workspace.navigateToAgentLocation}
              projectId={scope.projectId}
              projectTabs={workspace.projectTabs}
              rows={rows.agentRows}
            />
            <FileResults
              activateTab={actions.activateTab}
              fileMatches={rows.fileMatches}
              openFile={actions.openFile}
              openFileRows={rows.openFileRows}
              terminalRows={rows.terminalRows}
              worktreeById={scope.worktreeById}
            />
            <CodeResults
              codeMatches={rows.codeMatches}
              deferredQuery={state.deferredQuery}
              hostError={state.hostError}
              openFile={actions.openFile}
            />
          </CommandList>
        )}
      </Command>
    </CommandDialog>
  );
}
