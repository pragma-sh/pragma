import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage } from "@/lib/errors";

import type { Tab } from "@pragma/constants";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { RotateCw } from "lucide-react";

import { pragmaEditorTheme } from "@/components/editor/codemirror-theme";
import { Button } from "@/components/ui/button";
import { readDaemonLog } from "@/lib/tauri";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: string }
  | { kind: "error"; message: string };

const READ_ONLY = [EditorState.readOnly.of(true), EditorView.editable.of(false), pragmaEditorTheme];

/**
 * Read-only viewer for the detached PTY daemon's log file (`log` tabs, opened
 * from the Troubleshooting menu). The log isn't worktree-scoped, so it loads
 * through the dedicated `readDaemonLog` command rather than the file editor.
 * Logs grow as the daemon runs, so a Refresh button re-reads on demand.
 */
export function LogView({ tab }: { tab: Tab }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const doc = await readDaemonLog();
        if (!cancelled) {
          setState({ kind: "ready", doc: doc || "The server log is empty." });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyed on the tab id so a reopened log tab reloads fresh contents.
  useEffect(() => load(), [load, tab.id]);

  const extensions = useMemo(() => READ_ONLY, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">Daemon log</span>
        <Button onClick={load} size="sm" variant="ghost">
          <RotateCw className="size-3.5" />
          Refresh
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.kind === "loading" ? (
          <Placeholder>Loading…</Placeholder>
        ) : state.kind === "error" ? (
          <Placeholder>
            <p className="text-destructive">{state.message}</p>
            <Button className="mt-3" onClick={load} size="sm" variant="ghost">
              Retry
            </Button>
          </Placeholder>
        ) : (
          <CodeMirror
            className="h-full"
            editable={false}
            extensions={extensions}
            height="100%"
            readOnly
            theme="none"
            value={state.doc}
          />
        )}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
