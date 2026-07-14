import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  Clock,
  FileClock,
  Files,
  FolderGit2,
  Globe,
  LayoutGrid,
  PanelRight,
  RefreshCw,
  Server,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { constants, type Worktree } from "@pragma/constants";

import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { errorMessage } from "@/lib/errors";
import {
  restartDaemon,
  tunnelStart,
  tunnelStatus,
  tunnelStop,
  type TunnelStatus,
} from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";
import { useRightSidebar } from "@/state/right-sidebar-context";
import { useWorkspace } from "@/state/workspace-context";
import { rankEditorWorktrees } from "./command-mode-ranking";

interface CommandModeProps {
  query: string;
  selectedEditorId: string | null;
  setSelectedEditorId: (editorId: string | null) => void;
  setQuery: (query: string) => void;
  close: () => void;
  worktrees: Worktree[];
  recencyByWorktree: Record<string, number>;
}

interface PaletteCommand {
  id: string;
  label: string;
  keywords: string;
  icon: typeof Server;
  disabled?: boolean;
  run: () => void;
}

type EditorLauncher = (typeof constants.editorLaunchers.options)[number];

interface CommandModeListProps extends Pick<
  CommandModeProps,
  "query" | "setSelectedEditorId" | "setQuery" | "close" | "worktrees" | "recencyByWorktree"
> {
  commands: PaletteCommand[];
  editor: EditorLauncher | undefined;
  workspace: ReturnType<typeof useWorkspace>;
}

function worktreeLabel(worktree: Worktree): string {
  return worktree.title || worktree.branch;
}

function matches(query: string, ...values: string[]): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return (
    normalized.length === 0 ||
    values.some((value) => value.toLocaleLowerCase().includes(normalized))
  );
}

function useRemoteAccess(): TunnelStatus | null {
  const [remoteAccess, setRemoteAccess] = useState<TunnelStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void tunnelStatus()
      .then((status) => {
        if (!cancelled) setRemoteAccess(status);
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setRemoteAccess({ state: "error", value: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return remoteAccess;
}

function remoteAccessLabel(remoteAccess: TunnelStatus | null, enabled: boolean): string {
  if (!remoteAccess) return "Loading remote access status...";
  return enabled ? "Disable remote access" : "Enable remote access";
}

function CommandModeList({
  query,
  setSelectedEditorId,
  setQuery,
  close,
  worktrees,
  recencyByWorktree,
  commands,
  editor,
  workspace,
}: CommandModeListProps) {
  const editorWorktrees = useMemo(
    () => rankEditorWorktrees(worktrees, query, recencyByWorktree),
    [query, recencyByWorktree, worktrees],
  );

  if (editor) {
    return (
      <CommandList className="max-h-[min(60vh,32rem)]">
        <CommandEmpty>No matching worktrees.</CommandEmpty>
        <CommandGroup heading={`Open in ${editor.name}`}>
          {editorWorktrees.map((worktree) => {
            const remote = workspace.remoteWorktrees[worktree.id] === true;
            return (
              <CommandItem
                disabled={remote}
                key={worktree.id}
                onSelect={() => {
                  close();
                  void workspace.openWorktreeInEditor(worktree.id, editor.id);
                }}
                value={`editor-worktree:${worktree.id}`}
              >
                <FolderGit2 />
                <span>{worktreeLabel(worktree)}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {remote ? "Unavailable for remote worktrees" : worktree.branch}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    );
  }

  const commandRows = commands.filter((command) => matches(query, command.label, command.keywords));
  const editorRows = constants.editorLaunchers.options.filter((option) =>
    matches(query, `Open in ${option.name}`, "editor worktree launcher"),
  );

  return (
    <CommandList className="max-h-[min(60vh,32rem)]">
      <CommandEmpty>No matching commands.</CommandEmpty>
      {editorRows.length > 0 ? (
        <CommandGroup heading="Open worktree">
          {editorRows.map((option) => (
            <CommandItem
              key={option.id}
              onSelect={() => {
                setSelectedEditorId(option.id);
                setQuery(">");
              }}
              value={`open-editor:${option.id}`}
            >
              <Icon
                className="size-4"
                icon={option.brandIcon}
                style={{ color: option.brandColor }}
              />
              <span>Open in {option.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {commandRows.length > 0 ? (
        <CommandGroup heading="Commands">
          {commandRows.map((command) => (
            <CommandItem
              disabled={command.disabled}
              key={command.id}
              onSelect={command.run}
              value={`command:${command.id}`}
            >
              <command.icon />
              <span>{command.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </CommandList>
  );
}

/** Fire-and-forget workspace actions shown after the palette's `>` prefix. */
export function CommandMode({
  query,
  selectedEditorId,
  setSelectedEditorId,
  setQuery,
  close,
  worktrees,
  recencyByWorktree,
}: CommandModeProps) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const rightSidebar = useRightSidebar();
  const remoteAccess = useRemoteAccess();

  const runAsync = (promise: Promise<unknown>, success: string, pending?: string) => {
    close();
    const toastId = pending ? toast.loading(pending) : undefined;
    void promise
      .then(() => toast.success(success, { id: toastId }))
      .catch((cause: unknown) => toast.error(errorMessage(cause), { id: toastId }));
  };

  const remoteAccessEnabled =
    remoteAccess?.state === "active" || remoteAccess?.state === "starting";
  const commands: PaletteCommand[] = [
    {
      id: "remote-access",
      label: remoteAccessLabel(remoteAccess, remoteAccessEnabled),
      keywords: "gateway tunnel mobile pair",
      icon: Globe,
      disabled: remoteAccess === null,
      run: () => {
        if (!remoteAccess) return;
        runAsync(
          remoteAccessEnabled ? tunnelStop() : tunnelStart(),
          remoteAccessEnabled ? "Remote access disabled" : "Remote access enabled",
          remoteAccessEnabled ? "Disabling remote access..." : "Enabling remote access...",
        );
      },
    },
    {
      id: "restart-server",
      label: "Restart server",
      keywords: "daemon app host troubleshooting",
      icon: RefreshCw,
      run: () => runAsync(restartDaemon(), "Server restarted", "Restarting server..."),
    },
    {
      id: "server-logs",
      label: "Open server logs",
      keywords: "daemon troubleshooting log",
      icon: FileClock,
      disabled: !workspace.selectedWorktreeId,
      run: () => {
        close();
        void workspace.openDaemonLogTab();
      },
    },
    {
      id: "new-terminal",
      label: "New terminal tab",
      keywords: "shell tab",
      icon: Terminal,
      disabled: !workspace.selectedWorktreeId,
      run: () => {
        close();
        void workspace.createTerminalTab();
      },
    },
    {
      id: "new-browser",
      label: "New browser tab",
      keywords: "web tab",
      icon: Server,
      disabled: !workspace.selectedWorktreeId,
      run: () => {
        close();
        void workspace.createBrowserTab();
      },
    },
    {
      id: "prompt-board",
      label: "Open prompt board",
      keywords: "kanban tasks workspace",
      icon: LayoutGrid,
      disabled: !workspace.selectedProjectId,
      run: () => {
        kanban.openBoard();
        close();
      },
    },
    {
      id: "automations",
      label: "Open automations",
      keywords: "scheduled tasks workspace",
      icon: Clock,
      run: () => {
        kanban.openAutomations();
        close();
      },
    },
    {
      id: "files",
      label: "Open Files sidebar",
      keywords: "right sidebar explorer",
      icon: Files,
      disabled: !workspace.selectedWorktreeId,
      run: () => {
        kanban.exitBoard();
        rightSidebar.setActiveSubtab("files");
        rightSidebar.setCollapsed(false);
        close();
      },
    },
    {
      id: "changes",
      label: "Open Changes sidebar",
      keywords: "git right sidebar diff",
      icon: PanelRight,
      disabled: !workspace.selectedWorktreeId,
      run: () => {
        kanban.exitBoard();
        rightSidebar.setActiveSubtab("changes");
        rightSidebar.setCollapsed(false);
        close();
      },
    },
  ];

  const editor = constants.editorLaunchers.options.find((option) => option.id === selectedEditorId);

  return (
    <CommandModeList
      close={close}
      commands={commands}
      editor={editor}
      query={query}
      recencyByWorktree={recencyByWorktree}
      setQuery={setQuery}
      setSelectedEditorId={setSelectedEditorId}
      workspace={workspace}
      worktrees={worktrees}
    />
  );
}
