import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";

import type { AgentSlashCommand, ResolvedAgentOptions } from "@pragma-sh/plugin";

import type { MarkdownEditorHandle } from "@/components/github/MarkdownEditor";
import {
  defaultPermissionMode,
  filterSlashCommands,
  nextMode,
  rememberPermissionMode,
  sharedSlashCommands,
  slashMenuKeyAction,
  slashQuery,
  splitSlashPrompt,
} from "@/lib/agent-launch-options";
import type { AgentModelSelection } from "@/lib/tauri";
import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { resolvePluginAgentOptions } from "@/plugins/agents";

const EMPTY_OPTIONS: ResolvedAgentOptions = { modes: [], permissionModes: [], slashCommands: [] };

/** Launch-option state for the new-session prompt: mode, permission mode, and `/` picker. */
export interface AgentLaunchOptionsState {
  options: ResolvedAgentOptions;
  modeId: string | null;
  permissionModeId: string | null;
  setPermissionModeId: (id: string) => void;
  /** Advances to the next mode (Shift+Tab). */
  cycleMode: () => void;
  /** Commands matching the typed `/query`; empty when the picker is closed. */
  slashMatches: AgentSlashCommand[];
  slashIndex: number;
  setSlashIndex: (index: number) => void;
  slashMenuOpen: boolean;
  dismissSlashMenu: () => void;
  selectSlashCommand: (name: string) => void;
  /** Editor key handling: picker navigation and Shift+Tab mode cycling. */
  handleKeyDown: (event: KeyboardEvent) => void;
  /** Merges the launch options and the prompt's `/command` into a model selection. */
  applyToLaunch: (
    selection: AgentModelSelection,
    message: string,
  ) => { selection: AgentModelSelection; prompt: string };
}

/**
 * Resolves the selected agent's modes, permission modes, and slash commands and
 * tracks the user's choices for the launch. `message` is the prompt markdown;
 * `editor` rewrites it when a `/` command is picked.
 *
 * `agents` is one agent id, or — for a fanout, where one prompt goes to several
 * attempts verbatim — the attempts' agent ids: the picker then offers only the
 * slash commands every one of them has, and no modes or permission modes.
 */
export function useAgentLaunchOptions(
  agents: string | readonly string[] | null,
  isOpen: boolean,
  message: string,
  editor: RefObject<MarkdownEditorHandle | null>,
): AgentLaunchOptionsState {
  const agentId = typeof agents === "string" ? agents : null;
  const options = useResolvedOptions(agents, isOpen);
  const [modeId, setModeId] = useState<string | null>(null);
  const [permissionModeId, setPermissionModeIdState] = useState<string | null>(null);

  // Reset to the agent's defaults whenever the agent or its resolved lists change.
  useEffect(() => {
    setModeId(options.modes[0]?.id ?? null);
    setPermissionModeIdState(
      agentId ? defaultPermissionMode(agentId, options.permissionModes) : null,
    );
  }, [agentId, options]);

  const setPermissionModeId = useCallback(
    (id: string) => {
      setPermissionModeIdState(id);
      if (agentId) rememberPermissionMode(agentId, id);
    },
    [agentId],
  );
  const cycleMode = useCallback(() => {
    setModeId((current) => nextMode(options.modes, current));
  }, [options.modes]);

  const slash = useSlashMenu(options.slashCommands, message, editor);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (slash.handleKeyDown(event)) return;
      if (event.key === "Tab" && event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (options.modes.length === 0) return;
        event.preventDefault();
        cycleMode();
      }
    },
    [slash, options.modes.length, cycleMode],
  );

  const applyToLaunch = useCallback(
    (selection: AgentModelSelection, text: string) => {
      const { slashCommand, prompt } = splitSlashPrompt(text, options.slashCommands);
      return {
        selection: { ...selection, modeId, permissionModeId, slashCommand },
        prompt,
      };
    },
    [options.slashCommands, modeId, permissionModeId],
  );

  return {
    options,
    modeId,
    permissionModeId,
    setPermissionModeId,
    cycleMode,
    slashMatches: slash.matches,
    slashIndex: slash.index,
    setSlashIndex: slash.setIndex,
    slashMenuOpen: slash.open,
    dismissSlashMenu: slash.dismiss,
    selectSlashCommand: slash.select,
    handleKeyDown,
    applyToLaunch,
  };
}

/** A caret picker Escape should close before the dialog around it. */
export interface DismissiblePicker {
  open: boolean;
  dismiss: () => void;
}

/** The `/` picker of a launch-options state, as a {@link DismissiblePicker}. */
export function slashPicker(
  launch: Pick<AgentLaunchOptionsState, "slashMenuOpen" | "dismissSlashMenu">,
): DismissiblePicker {
  return { open: launch.slashMenuOpen, dismiss: launch.dismissSlashMenu };
}

/** Escape first closes an open picker (`/` commands, `@` context), then the dialog. */
export function useEscapeClosesPickerFirst(
  open: boolean,
  pickers: readonly DismissiblePicker[],
  onClose: () => void,
): void {
  // `useEscapeToClose` listens in the capture phase, ahead of the editor, so the
  // picker's dismissal has to be decided here rather than in the key handler.
  useEscapeToClose(open, () => {
    const picker = pickers.find((candidate) => candidate.open);
    if (picker) picker.dismiss();
    else onClose();
  });
}

/**
 * Resolves one agent's options, or the slash commands shared by several agents,
 * while the dialog is open. Results are cached per agent id.
 */
function useResolvedOptions(
  agents: string | readonly string[] | null,
  isOpen: boolean,
): ResolvedAgentOptions {
  const single = typeof agents === "string" ? agents : null;
  // Keyed by value so a fresh array with the same ids does not re-resolve.
  const key =
    agents === null ? "" : typeof agents === "string" ? agents : [...new Set(agents)].join("\n");
  const ids = useMemo(() => (key ? key.split("\n") : []), [key]);
  const [resolved, setResolved] = useState<Record<string, ResolvedAgentOptions>>({});
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    for (const id of ids) {
      void resolvePluginAgentOptions(id)
        .then((options) => {
          if (!cancelled && options) {
            setResolved((current) => ({ ...current, [id]: options }));
          }
          return undefined;
        })
        .catch((cause: unknown) => {
          console.warn(`failed to resolve launch options for ${id}`, cause);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [ids, isOpen]);
  return useMemo(() => {
    if (single !== null) return resolved[single] ?? EMPTY_OPTIONS;
    const lists = ids.map((id) => resolved[id]?.slashCommands);
    if (lists.length === 0 || lists.some((list) => list === undefined)) return EMPTY_OPTIONS;
    return { ...EMPTY_OPTIONS, slashCommands: sharedSlashCommands(lists as AgentSlashCommand[][]) };
  }, [single, ids, resolved]);
}

interface SlashMenu {
  matches: AgentSlashCommand[];
  index: number;
  setIndex: (index: number) => void;
  open: boolean;
  dismiss: () => void;
  select: (name: string) => void;
  /** Returns true when the key was consumed by the open picker. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

function useSlashMenu(
  commands: AgentSlashCommand[],
  message: string,
  editor: RefObject<MarkdownEditorHandle | null>,
): SlashMenu {
  const query = slashQuery(message);
  const [index, setIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const matches = useMemo(
    () => (query === null || query === dismissedQuery ? [] : filterSlashCommands(commands, query)),
    [commands, query, dismissedQuery],
  );
  const open = matches.length > 0;
  // Adjust during render when the typed query changes: restart at the top row
  // and forget a dismissal once the user keeps typing.
  const [previousQuery, setPreviousQuery] = useState(query);
  if (previousQuery !== query) {
    setPreviousQuery(query);
    setIndex(0);
    if (dismissedQuery !== null && dismissedQuery !== query) setDismissedQuery(null);
  }

  const dismiss = useCallback(() => setDismissedQuery(query), [query]);
  const select = useCallback(
    (name: string) => {
      // Markdown serialization may drop the trailing space, leaving `/<name>`
      // as the query; dismissing it keeps the picker closed after a pick.
      setDismissedQuery(name);
      editor.current?.setMarkdown(`/${name} `);
    },
    [editor],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const action = open ? slashMenuKeyAction(event) : null;
      if (!action) return false;
      event.preventDefault();
      if (action === "select") {
        const command = matches[Math.min(index, matches.length - 1)];
        if (command) select(command.name);
      } else {
        const step = action === "next" ? 1 : -1;
        setIndex((current) => (current + step + matches.length) % matches.length);
      }
      return true;
    },
    [open, matches, index, select],
  );
  return { matches, index, setIndex, open, dismiss, select, handleKeyDown };
}
