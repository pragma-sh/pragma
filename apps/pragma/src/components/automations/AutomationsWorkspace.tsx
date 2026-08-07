import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Clock, Play, ShieldCheck, ShieldQuestion, X } from "lucide-react";

import type { AutomationInfo, FileContents } from "@pragma/constants";
import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { toast } from "sonner";

import { loadLanguageExtension } from "@/components/editor/codemirror-language";
import { pragmaEditorTheme, pragmaSyntaxHighlighting } from "@/components/editor/codemirror-theme";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { readAutomationSource, writeAutomationSource } from "@/lib/tauri";
import { startWindowDrag } from "@/lib/window-drag";
import { cn } from "@/lib/utils";
import { useAutomations } from "@/state/automations-context";
import { useKanban } from "@/state/kanban-context";

type SourceState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; message: string };

export function AutomationsWorkspace({ embedded = false }: { embedded?: boolean }) {
  const kanban = useKanban();
  const { automations, loading } = useAutomations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    automations.find((automation) => automation.id === selectedId) ?? automations[0] ?? null;
  const grouped = useMemo(() => groupAutomations(automations), [automations]);

  const header = (
    /* Titlebar drag strip: the standalone workspace replaces the project
        sidebar (which otherwise owns the drag handle), so it exposes one
        itself. Embedded in Settings the settings header owns the drag strip. */
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- window-drag handle is a pointer-only OS affordance with no ARIA role or keyboard equivalent */
    <header
      className={
        embedded
          ? "flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-3"
          : "flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 pt-[calc(var(--titlebar-height,0px)+0.75rem)] pb-3"
      }
      onMouseDown={embedded ? undefined : startWindowDrag}
    >
      <div>
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-cyan-300" />
          <h1 className="text-sm font-semibold">Automations</h1>
          {loading ? <Pill>loading</Pill> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Host-side cron and event automations from <code>~/.pragma</code> and project{" "}
          <code>.pragma</code>.
        </p>
      </div>
      {embedded ? null : (
        <Button
          aria-label="Exit automations"
          size="icon-sm"
          variant="ghost"
          onClick={() => kanban.exitBoard()}
        >
          <X />
        </Button>
      )}
    </header>
  );

  const body = (
    <div className="flex min-h-0 flex-1">
      <aside className="w-72 shrink-0 overflow-auto border-r border-sidebar-border bg-sidebar p-3">
        <AutomationGroup
          automations={grouped.global}
          label="Global"
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
        <AutomationGroup
          automations={grouped.localMain}
          label="Local"
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
        />
        {grouped.worktrees.map(([label, items]) => (
          <div className="mt-4 border-l border-sidebar-border pl-3" key={label}>
            <AutomationGroup
              automations={items}
              label={`worktree: ${label}`}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          </div>
        ))}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <AutomationEditor automation={selected} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No automations found. Add a <code className="mx-1">.ts</code> file under{" "}
            <code className="mx-1">.pragma/automations</code>.
          </div>
        )}
      </main>
    </div>
  );

  if (embedded) {
    return (
      <div className="bg-canvas flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {header}
        {body}
      </div>
    );
  }

  return (
    <section className="bg-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {header}
      {body}
    </section>
  );
}

/** Editor source state plus the save/change handlers, extracted from the view. */
function useAutomationSource(automation: AutomationInfo) {
  const [state, setState] = useState<SourceState>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    if (dirty) return;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const contents: FileContents = await readAutomationSource(automation.id);
        if (cancelled) return;
        setState(sourceStateFor(contents));
        if (!contents.truncated && !contents.binary) {
          savedDocRef.current = contents.text;
          currentDocRef.current = contents.text;
        }
      } catch (cause) {
        if (!cancelled) setState({ kind: "error", message: errorMessage(cause) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automation.id, automation.sourceVersion, dirty, reloadNonce]);

  const saveSource = useCallback(
    async (contents: string) => {
      try {
        await writeAutomationSource(automation.id, contents);
        savedDocRef.current = contents;
        currentDocRef.current = contents;
        setDirty(false);
        toast.success("Automation saved");
      } catch (cause) {
        toast.error(errorMessage(cause));
      }
    },
    [automation.id],
  );

  const onChange = useCallback((value: string) => {
    currentDocRef.current = value;
    setDirty(value !== savedDocRef.current);
    setState((previous) => (previous.kind === "ready" ? { ...previous, doc: value } : previous));
  }, []);

  const retry = useCallback(() => setReloadNonce((nonce) => nonce + 1), []);

  return { state, dirty, currentDocRef, saveSource, onChange, retry };
}

/** Maps a fetched file's contents to the editor's source state. */
function sourceStateFor(contents: FileContents): SourceState {
  if (contents.truncated)
    return { kind: "unsupported", reason: "This automation source is too large to show." };
  if (contents.binary) return { kind: "unsupported", reason: "This automation source is binary." };
  return { kind: "ready", doc: contents.text };
}

function AutomationEditor({ automation }: { automation: AutomationInfo }) {
  const { state, dirty, currentDocRef, saveSource, onChange, retry } =
    useAutomationSource(automation);

  const handleSaveShortcut = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (state.kind !== "ready") return;
        void saveSource(currentDocRef.current);
      }
    },
    [saveSource, state.kind, currentDocRef],
  );

  return (
    <>
      <EditorToolbar
        automation={automation}
        dirty={dirty}
        canSave={state.kind === "ready"}
        onSave={() => void saveSource(currentDocRef.current)}
      />
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown relay only */}
      <div className="relative min-h-0 flex-1" onKeyDown={handleSaveShortcut}>
        <EditorBody
          automation={automation}
          state={state}
          onChange={onChange}
          onSave={saveSource}
          onRetry={retry}
        />
      </div>
    </>
  );
}

function EditorToolbar({
  automation,
  dirty,
  canSave,
  onSave,
}: {
  automation: AutomationInfo;
  dirty: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  const { approve, reject, runNow } = useAutomations();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-sidebar-border bg-sidebar px-4 py-3">
      <h2 className="text-lg font-semibold">{automation.name}</h2>
      <StatusBadge automation={automation} />
      <Pill>{automation.triggerKind}</Pill>
      <p className="basis-full text-xs text-muted-foreground">
        {automation.description || "No description."}
      </p>
      <p className="basis-full break-all font-mono text-xs text-muted-foreground">
        {automation.path}
      </p>
      <div className="flex flex-1 justify-end gap-2">
        {automation.trust === "pending" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void reject(automation.id)}>
              Reject
            </Button>
            <Button size="sm" onClick={() => void approve(automation.id)}>
              Trust
            </Button>
          </>
        ) : null}
        {dirty ? <Pill>unsaved</Pill> : null}
        <Button disabled={!dirty || !canSave} size="sm" variant="outline" onClick={onSave}>
          Save
        </Button>
        <Button
          disabled={automation.trust === "pending" || automation.trust === "rejected"}
          size="sm"
          variant="secondary"
          onClick={() => {
            void runNow(automation.id).then(
              () => toast.success("Automation started"),
              (cause) => toast.error(errorMessage(cause)),
            );
          }}
        >
          <Play className="size-3.5" />
          Run now
        </Button>
      </div>
      {automation.error ? (
        <div className="basis-full rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {automation.error}
        </div>
      ) : null}
    </div>
  );
}

function EditorBody({
  automation,
  state,
  onChange,
  onSave,
  onRetry,
}: {
  automation: AutomationInfo;
  state: SourceState;
  onChange: (value: string) => void;
  onSave: (doc: string) => void;
  onRetry: () => void;
}) {
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLanguageExtension(null);
    void (async () => {
      const extension = await loadLanguageExtension(automation.relativePath || automation.path);
      if (!cancelled) setLanguageExtension(extension);
    })();
    return () => {
      cancelled = true;
    };
  }, [automation.relativePath, automation.path]);

  const extensions = useMemo(() => {
    const base = [pragmaEditorTheme, pragmaSyntaxHighlighting, saveKeymap(onSave)];
    return languageExtension ? [...base, languageExtension] : base;
  }, [languageExtension, onSave]);

  if (state.kind === "loading") return <Placeholder>Loading source…</Placeholder>;
  if (state.kind === "unsupported") return <Placeholder>{state.reason}</Placeholder>;
  if (state.kind === "error") {
    return (
      <Placeholder>
        <p className="text-destructive">{state.message}</p>
        <Button className="mt-3" onClick={onRetry} size="sm" variant="ghost">
          Retry
        </Button>
      </Placeholder>
    );
  }
  return (
    <CodeMirror
      className="h-full"
      extensions={extensions}
      height="100%"
      onChange={onChange}
      theme="none"
      value={state.doc}
    />
  );
}

/** Mod-S keymap that saves the current editor document. */
function saveKeymap(onSave: (doc: string) => void): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: (view) => {
          onSave(view.state.doc.toString());
          return true;
        },
      },
    ]),
  );
}

function AutomationGroup({
  automations,
  label,
  selectedId,
  onSelect,
}: {
  automations: AutomationInfo[];
  label: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (automations.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 space-y-1">
        {automations.map((automation) => (
          <button
            className={cn(
              "w-full rounded-lg px-2 py-2 text-left transition hover:bg-accent/70",
              selectedId === automation.id && "bg-accent",
            )}
            key={automation.id}
            type="button"
            onClick={() => onSelect(automation.id)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{automation.name}</span>
              {automation.trust === "pending" ? (
                <ShieldQuestion className="size-3.5 text-amber-300" />
              ) : null}
              {automation.trust === "approved" || automation.trust === "trusted" ? (
                <ShieldCheck className="size-3.5 text-emerald-300" />
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {automation.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ automation }: { automation: AutomationInfo }) {
  const label = automation.trust === "rejected" ? "rejected" : automation.status;
  return (
    <Pill
      tone={automation.status === "error" || automation.trust === "rejected" ? "danger" : "muted"}
    >
      {label}
    </Pill>
  );
}

function Pill({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "danger" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "danger"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function groupAutomations(automations: AutomationInfo[]): {
  global: AutomationInfo[];
  localMain: AutomationInfo[];
  worktrees: Array<[string, AutomationInfo[]]>;
} {
  const global = automations.filter((automation) => automation.scope === "global");
  const local = automations.filter((automation) => automation.scope === "local");
  const localMain = local.filter((automation) => !automation.worktreeId);
  const byWorktree = new Map<string, AutomationInfo[]>();
  for (const automation of local) {
    if (!automation.worktreeId) continue;
    const label = automation.worktreeLabel ?? automation.worktreeId;
    byWorktree.set(label, [...(byWorktree.get(label) ?? []), automation]);
  }
  return { global, localMain, worktrees: [...byWorktree.entries()] };
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
