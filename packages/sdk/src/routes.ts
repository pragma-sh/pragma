/** Gateway HTTP route builders. */
export const routes = {
  health: "/v1/health",
  version: "/v1/version",
  rpc: (method: string): string => `/v1/rpc/${encodeURIComponent(method)}`,
  sessions: "/v1/sessions",
  sessionEvents: (id: string): string => `/v1/sessions/${encodeURIComponent(id)}/events`,
  sessionInput: (id: string): string => `/v1/sessions/${encodeURIComponent(id)}/input`,
  sessionResize: (id: string): string => `/v1/sessions/${encodeURIComponent(id)}/resize`,
  session: (id: string): string => `/v1/sessions/${encodeURIComponent(id)}`,
  agentReports: "/v1/agents/reports",
  agentEvents: "/v1/agents/events",
  agentsSeen: (tabId: string): string => `/v1/tabs/${encodeURIComponent(tabId)}/agents/seen`,
  subscription: (event: string): string => `/v1/subscriptions/${encodeURIComponent(event)}`,
} as const;
