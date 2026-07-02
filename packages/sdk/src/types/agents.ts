import type { AgentAttentionKind, AgentReportPayload, AgentStatus } from "@pragma/constants";

export type { AgentAttentionKind, AgentReportPayload, AgentStatus };

export interface AgentEvent {
  type: "agent";
  worktreeId: string;
  tabId: string;
  agent: string;
  status: AgentStatus;
  attentionKind: AgentAttentionKind | null;
}

export interface ReportOptions {
  agent: string;
  worktreeId?: string;
  kind?: AgentAttentionKind;
  client?: import("../client").PragmaClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}
