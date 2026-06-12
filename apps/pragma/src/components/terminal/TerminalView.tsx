import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { activateSession, createSession, scheduleDispose } from "@/lib/terminal-manager";

interface Props {
  sessionId: string;
  cwd: string;
  useAttach: boolean;
  visible: boolean;
}

export function TerminalView({ sessionId, cwd, useAttach, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Create the session the first time the tab becomes visible (xterm can't
  // measure a display:none container), then refit on every later activation.
  // createSession is idempotent, so revisiting a tab reuses its live shell.
  useEffect(() => {
    if (!visible || !containerRef.current) return;
    createSession(sessionId, cwd, containerRef.current, useAttach);
    activateSession(sessionId);
  }, [sessionId, cwd, useAttach, visible]);

  // Dispose only when the tab is actually closed (component unmounts). Deferred
  // so a StrictMode remount cancels it and keeps the shell + scrollback alive.
  useEffect(() => {
    return () => scheduleDispose(sessionId);
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
