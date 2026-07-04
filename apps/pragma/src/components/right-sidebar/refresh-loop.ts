export function startRefreshLoop(refresh: () => void, intervalMs: number): () => void {
  void refresh();
  const interval = setInterval(() => void refresh(), intervalMs);
  window.addEventListener("focus", refresh);
  return () => {
    clearInterval(interval);
    window.removeEventListener("focus", refresh);
  };
}
