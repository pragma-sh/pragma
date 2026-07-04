/**
 * Runs `refresh` immediately, then on an interval, and again on window focus.
 *
 * Interval ticks are skipped while the document is hidden (window minimized /
 * fully occluded): the data is invisible, and every poller that reaches the
 * daemon costs a git round-trip — the focus listener catches the app back up
 * the moment it becomes relevant again. Returns a stop function.
 */
export function startRefreshLoop(refresh: () => void, intervalMs: number): () => void {
  void refresh();
  const interval = setInterval(() => {
    if (!document.hidden) {
      void refresh();
    }
  }, intervalMs);
  window.addEventListener("focus", refresh);
  return () => {
    clearInterval(interval);
    window.removeEventListener("focus", refresh);
  };
}
