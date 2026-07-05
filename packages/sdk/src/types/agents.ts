import type {
  AgentAttentionKind,
  AgentMessage,
  AgentReportPayload,
  AgentStatus,
} from "@pragma/constants";

export type { AgentAttentionKind, AgentMessage, AgentReportPayload, AgentStatus };

export interface AgentEvent {
  type: "agent";
  worktreeId: string;
  tabId: string;
  agent: string;
  status: AgentStatus;
  attentionKind: AgentAttentionKind | null;
}

export interface AgentMessageEvent {
  type: "agentMessage";
  message: AgentMessage;
}

export type AgentStreamEvent = AgentEvent | AgentMessageEvent;

export interface ReportOptions {
  agent: string;
  worktreeId?: string;
  kind?: AgentAttentionKind;
  client?: import("../client").PragmaClient;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export type ReportMessageOptions = Omit<ReportOptions, "kind"> & {
  message: Omit<AgentMessage, "agent" | "worktreeId" | "tabId"> &
    Partial<Pick<AgentMessage, "agent" | "worktreeId" | "tabId">>;
};
