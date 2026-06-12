import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptyAttach, ptyResize, ptySpawn, ptyWrite, type PtyEvent } from "./tauri";

export interface TerminalSession {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  disposed: boolean;
  dispose: () => void;
  resizeObserver: ResizeObserver;
}

/** Chords that must bubble to the window-level shortcut handler, not xterm. */
const passthroughChords = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Tab"]);

const sessions = new Map<string, TerminalSession>();
/** Disposals are deferred so a React StrictMode remount can cancel them. */
const pendingDisposal = new Map<string, ReturnType<typeof setTimeout>>();

function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** xterm can't measure a `display:none`/zero-size container — fitting one throws. */
function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0;
}

/** Fit the terminal only when its container is actually laid out. */
function safeFit(session: TerminalSession) {
  if (session.disposed || !isVisible(session.container)) return;
  try {
    session.fitAddon.fit();
  } catch {
    // The renderer may not be ready on the very first frame; ignore and retry later.
  }
}

/**
 * Build (or reuse) the xterm session for `sessionId` and open it in `container`.
 *
 * Idempotent per session: a second call (e.g. a StrictMode remount or a tab
 * re-activation) reuses the existing terminal instead of spawning a duplicate
 * shell. Output bypasses React entirely — it is written straight to xterm.
 */
export function createSession(
  sessionId: string,
  cwd: string,
  container: HTMLElement,
  useAttach: boolean,
): TerminalSession {
  const pending = pendingDisposal.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    pendingDisposal.delete(sessionId);
  }

  const existing = sessions.get(sessionId);
  if (existing && !existing.disposed) {
    if (existing.container !== container) {
      existing.container = container;
      existing.term.open(container);
    }
    safeFit(existing);
    return existing;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "monospace",
    theme: {
      background: "#09090b",
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
    },
  });

  term.loadAddon(new WebLinksAddon());

  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.altKey || e.metaKey) && passthroughChords.has(e.key)) return false;
    return true;
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  term.open(container);

  const session: TerminalSession = {
    term,
    fitAddon,
    container,
    disposed: false,
    dispose: () => {},
    resizeObserver: undefined as unknown as ResizeObserver,
  };

  safeFit(session);

  const cols = term.cols;
  const rows = term.rows;

  const handleEvent = (event: PtyEvent) => {
    if (session.disposed) return;
    if (event.type === "output") {
      term.write(event.data);
    } else if (event.type === "error" && useAttach) {
      // The session is gone (e.g. the daemon was restarted after a reboot).
      // Fall back to spawning a fresh shell so the tab stays usable.
      void ptySpawn(sessionId, cwd, term.cols, term.rows, handleEvent);
    }
  };

  if (useAttach) {
    // Reattaching: replayed scrollback arrives first, then live frames. Resize
    // afterwards so the daemon SIGWINCHes the shell to the current geometry.
    // A missing session resolves via the `error` fallback above, so ignore the
    // resize rejection that races ahead of the fresh spawn.
    void ptyAttach(sessionId, cols, rows, handleEvent).then(() => {
      return ptyResize(sessionId, cols, rows).catch(() => undefined);
    });
  } else {
    void ptySpawn(sessionId, cwd, cols, rows, handleEvent);
  }

  term.onData((data) => {
    if (!session.disposed) ptyWrite(sessionId, data);
  });

  const debouncedResize = debounce(() => {
    if (session.disposed || !isVisible(container)) return;
    safeFit(session);
    ptyResize(sessionId, term.cols, term.rows);
  }, 75);

  const resizeObserver = new ResizeObserver(() => {
    debouncedResize();
  });
  resizeObserver.observe(container);

  session.resizeObserver = resizeObserver;
  session.dispose = () => {
    session.disposed = true;
    resizeObserver.disconnect();
    term.dispose();
  };

  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): TerminalSession | undefined {
  return sessions.get(sessionId);
}

/** Dispose immediately. Prefer `scheduleDispose` from React effect cleanups. */
export function disposeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    session.dispose();
    sessions.delete(sessionId);
  }
}

/**
 * Schedule disposal on the next tick. A StrictMode remount (or fast
 * re-activation) calls `createSession` synchronously first and cancels it, so
 * only a genuine unmount actually tears the session down.
 */
export function scheduleDispose(sessionId: string) {
  if (pendingDisposal.has(sessionId)) return;
  const handle = setTimeout(() => {
    pendingDisposal.delete(sessionId);
    disposeSession(sessionId);
  }, 0);
  pendingDisposal.set(sessionId, handle);
}

/** Refit a session when its tab becomes visible again. */
export function activateSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.disposed || !isVisible(session.container)) return;
  safeFit(session);
  ptyResize(sessionId, session.term.cols, session.term.rows);
}
