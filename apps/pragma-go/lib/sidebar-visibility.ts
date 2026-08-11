/** Whether a route needs persistent worktree navigation beside its content. */
export function routeNeedsSidebar(pathname: string): boolean {
  return pathname.startsWith("/chat/") || pathname.startsWith("/scratchpad/");
}
