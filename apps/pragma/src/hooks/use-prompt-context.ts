import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type ContextItem,
  type ContextWorktree,
  contextMention,
  contextQuery,
  formatPromptWithContext,
  isContextProviderNotice,
  matchContextItems,
  type PluginProject,
  splitPromptContext,
} from "@pragma-sh/plugin/catalog";

import type { MarkdownEditorHandle } from "@/components/github/MarkdownEditor";
import { slashMenuKeyAction } from "@/lib/agent-launch-options";
import { hasMention, unescapeMarkdown } from "@/lib/prompt-context";
import { type ActiveContextProvider, useContextProviders } from "@/plugins/context-providers";

/** Wait after the last keystroke before asking providers to search. */
const SEARCH_DEBOUNCE_MS = 120;

/** One pickable row: an item and the provider that offered it. */
export interface PromptContextOption {
  provider: ActiveContextProvider;
  item: ContextItem;
}

/** A mention's context source: picked now (resolved on submit) or restored from a saved prompt. */
interface Attachment {
  source: string;
  load: () => Promise<string>;
}

/** A provider heading and its matching rows, in picker order. */
export interface PromptContextGroup {
  provider: ActiveContextProvider;
  options: PromptContextOption[];
}

/** State of the prompt's `@` context picker and the items it has attached. */
export interface PromptContextState {
  /** Open while an `@` mention is being typed (and not dismissed), even with no matches. */
  open: boolean;
  /** The text typed after `@`, or `null` while the picker is closed. */
  query: string | null;
  /** Providers still searching for the current query. */
  loading: boolean;
  groups: PromptContextGroup[];
  /** Every row across groups, the order arrow keys walk. */
  options: PromptContextOption[];
  /** Messages providers raised instead of results (e.g. "Sign in…"), deduplicated. */
  notices: string[];
  index: number;
  setIndex: (index: number) => void;
  select: (option: PromptContextOption) => void;
  dismiss: () => void;
  /** Feed from {@link MarkdownEditor}'s `onCaretTextChange`. */
  onCaretTextChange: (textBeforeCaret: string) => void;
  /** Picker navigation; marks the event handled (`defaultPrevented`) when it consumes it. */
  handleKeyDown: (event: KeyboardEvent) => void;
  /**
   * Resolves every picked item whose mention is still in `prompt` and returns
   * the prompt with their context appended.
   */
  attachContext: (prompt: string) => Promise<string>;
  /**
   * Splits the context blocks off a saved prompt (one {@link attachContext}
   * produced), keeps them attached for the next save, and returns the text the
   * editor should show.
   */
  seedPrompt: (stored: string) => string;
}

/**
 * Drives the `@` context picker for an agent prompt: detects a mention being
 * typed, searches the built-in and plugin providers for `worktree`, inserts the
 * picked mention, and injects the resolved context on submit. `project` and
 * `worktree` may be fresh objects every render; they are compared by value.
 */
export function usePromptContext({
  isOpen,
  project: projectInput,
  worktree: worktreeInput,
  editor,
}: {
  isOpen: boolean;
  project: PluginProject | null | undefined;
  worktree: ContextWorktree | null | undefined;
  editor: RefObject<MarkdownEditorHandle | null>;
}): PromptContextState {
  const project = useStableProject(projectInput);
  const worktree = useStableWorktree(worktreeInput);
  const providers = useContextProviders(project?.id ?? null);
  const [caretText, setCaretText] = useState("");
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const attached = useRef(new Map<string, Attachment>());

  // A fresh dialog forgets what the previous prompt attached.
  useEffect(() => {
    if (!isOpen) {
      attached.current.clear();
      setCaretText("");
    }
  }, [isOpen]);

  const typed = isOpen ? contextQuery(caretText) : null;
  const query = typed !== null && typed !== dismissedQuery ? typed : null;
  const {
    results,
    notices: noticeByProvider,
    loading,
  } = useProviderResults(providers, query, project, worktree);

  const groups = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          options: (results[provider.key] ?? []).map((item) => ({ provider, item })),
        }))
        .filter((group) => group.options.length > 0),
    [providers, results],
  );
  const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const notices = useMemo(
    () => [
      ...new Set(
        providers.flatMap((provider) => {
          const notice = noticeByProvider[provider.key];
          return notice ? [notice] : [];
        }),
      ),
    ],
    [providers, noticeByProvider],
  );
  // Open for every mention being typed, so a bare `@` visibly does something
  // even when no provider has anything to offer.
  const open = query !== null;

  // Restart at the top row whenever the typed query changes, and forget a
  // dismissal once the user types past it.
  const [previousTyped, setPreviousTyped] = useState(typed);
  if (previousTyped !== typed) {
    setPreviousTyped(typed);
    setIndex(0);
    if (dismissedQuery !== null && dismissedQuery !== typed) setDismissedQuery(null);
  }

  const dismiss = useCallback(() => setDismissedQuery(typed), [typed]);
  const select = useCallback(
    (option: PromptContextOption) => {
      if (typed === null) return;
      const { provider, item } = option;
      const mention = contextMention(item);
      attached.current.set(mention, {
        source: provider.title,
        load: () => provider.resolve({ item, project, worktree }),
      });
      editor.current?.replaceBeforeCaret(typed.length + 1, `${mention} `);
    },
    [editor, typed, project, worktree],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const action = open && options.length > 0 ? slashMenuKeyAction(event) : null;
      if (!action) return;
      event.preventDefault();
      if (action === "select") {
        const option = options[Math.min(index, options.length - 1)];
        if (option) select(option);
      } else {
        const step = action === "next" ? 1 : -1;
        setIndex((current) => (current + step + options.length) % options.length);
      }
    },
    [open, options, index, select],
  );

  const attachContext = useCallback(async (prompt: string) => {
    const plain = unescapeMarkdown(prompt);
    const referenced = [...attached.current.entries()].filter(([mention]) =>
      hasMention(plain, mention),
    );
    const blocks = await Promise.all(
      referenced.map(async ([mention, { source, load }]) => {
        let content = "";
        try {
          content = await load();
        } catch (cause) {
          console.warn(`failed to resolve context ${mention} from ${source}`, cause);
        }
        return { mention, source, content };
      }),
    );
    return formatPromptWithContext(prompt, blocks);
  }, []);

  const seedPrompt = useCallback((stored: string) => {
    const { prompt, blocks } = splitPromptContext(stored);
    for (const block of blocks) {
      attached.current.set(block.mention, {
        source: block.source,
        load: async () => block.content,
      });
    }
    return prompt;
  }, []);

  return {
    open,
    query,
    loading,
    groups,
    options,
    notices,
    index,
    setIndex,
    select,
    dismiss,
    onCaretTextChange: setCaretText,
    handleKeyDown,
    attachContext,
    seedPrompt,
  };
}

function useStableProject(project: PluginProject | null | undefined): PluginProject | null {
  const id = project?.id;
  const name = project?.name;
  const path = project?.path;
  return useMemo(
    () =>
      id !== undefined && name !== undefined && path !== undefined ? { id, name, path } : null,
    [id, name, path],
  );
}

function useStableWorktree(worktree: ContextWorktree | null | undefined): ContextWorktree | null {
  const id = worktree?.id;
  const path = worktree?.path;
  const branch = worktree?.branch;
  return useMemo(
    () =>
      id !== undefined && path !== undefined && branch !== undefined ? { id, path, branch } : null,
    [id, path, branch],
  );
}

/**
 * Searches every provider for `query` (debounced, aborted when superseded) and
 * fills results in as each provider answers, so a slow one never holds the
 * rest back. A failing provider contributes nothing.
 */
function useProviderResults(
  providers: ActiveContextProvider[],
  query: string | null,
  project: PluginProject | null,
  worktree: ContextWorktree | null,
): {
  results: Record<string, ContextItem[]>;
  notices: Record<string, string | undefined>;
  loading: boolean;
} {
  const [results, setResults] = useState<Record<string, ContextItem[]>>({});
  const [notices, setNotices] = useState<Record<string, string | undefined>>({});
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (query === null) {
      setResults({});
      setNotices({});
      setPending(0);
      return;
    }
    const controller = new AbortController();
    // Loading from the first keystroke, not after the debounce, so the picker
    // never flashes its empty state before the search has started.
    setPending(providers.length);
    const timer = window.setTimeout(() => {
      for (const provider of providers) {
        void provider
          .search({ query, project, worktree, signal: controller.signal })
          .then((items) => ({ items, notice: undefined }))
          .catch((cause: unknown) => {
            if (isContextProviderNotice(cause)) return { items: [], notice: cause.message };
            if (!controller.signal.aborted) {
              console.warn(`context provider ${provider.key} failed`, cause);
            }
            return { items: [], notice: undefined };
          })
          .then(({ items, notice }) => {
            if (controller.signal.aborted) return undefined;
            setResults((current) => ({
              ...current,
              [provider.key]: matchContextItems(items, query),
            }));
            setNotices((current) => ({ ...current, [provider.key]: notice }));
            setPending((count) => Math.max(0, count - 1));
            return undefined;
          });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [providers, query, project, worktree]);
  return { results, notices, loading: pending > 0 };
}
