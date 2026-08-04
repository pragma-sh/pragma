/**
 * Runs `refresh` immediately, then on an interval, and again on window focus.
 *
 * Interval ticks are skipped while the document is hidden (window minimized /
 * fully occluded): the data is invisible, and every poller that reaches the
 * daemon costs a git round-trip — the focus listener catches the app back up
 * the moment it becomes relevant again. Returns a stop function.
 */
export function startRefreshLoop(
  refresh: () => void | Promise<unknown>,
  intervalMs: number,
): () => void {
  let refreshing = false;
  const runRefresh = () => {
    if (refreshing) return;
    refreshing = true;
    let result: void | Promise<unknown>;
    try {
      result = refresh();
    } catch {
      refreshing = false;
      return;
    }
    if (result instanceof Promise) {
      void result.then(
        () => {
          refreshing = false;
          return undefined;
        },
        () => {
          refreshing = false;
          return undefined;
        },
      );
    } else {
      refreshing = false;
    }
  };

  runRefresh();
  const interval = setInterval(() => {
    if (!document.hidden) {
      runRefresh();
    }
  }, intervalMs);
  window.addEventListener("focus", runRefresh);
  return () => {
    clearInterval(interval);
    window.removeEventListener("focus", runRefresh);
  };
}
