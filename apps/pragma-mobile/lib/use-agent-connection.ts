import type { AgentConnection } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useReducer, useRef, useState } from "react";

import { useConnection } from "./connection-context";
import { hapticSuccess, hapticWarning } from "./haptics";
import {
  applyEvent,
  applyLocalInput,
  emptyTranscript,
  transcriptRows,
  type TranscriptState,
} from "./transcript-store";
import type { AttentionRequest, ChatConnectionState, TranscriptRow } from "./types";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Identifies the running agent a chat screen attaches to. */
export interface AgentTarget {
  agent: string;
  tabId: string;
  worktreeId: string;
}

/** What a chat screen needs to render + drive one agent conversation. */
export interface AgentConversation {
  rows: TranscriptRow[];
  attention: AttentionRequest | null;
  phase: ChatConnectionState;
  send: (text: string) => void;
  interrupt: () => void;
  decide: (requestId: string, approved: boolean) => void;
  answer: (requestId: string, reply: string | null) => void;
}

type StoreAction =
  | { type: "reset" }
  | { type: "event"; event: Parameters<typeof applyEvent>[1] }
  | { type: "localInput"; text: string; ts: number };

function reducer(state: TranscriptState, action: StoreAction): TranscriptState {
  switch (action.type) {
    case "reset":
      return emptyTranscript();
    case "event":
      return applyEvent(state, action.event);
    case "localInput":
      return applyLocalInput(state, action.text, action.ts);
  }
}

/**
 * Attaches to one running agent for the lifetime of the focused chat screen:
 * opens a duplex {@link AgentConnection} on focus, folds its events into the
 * pure transcript store, reconnects with capped backoff on stream error, and
 * exposes send/interrupt/decide/answer talk-back. Buzzes when a new attention
 * request arrives and on approve/deny.
 */
export function useAgentConnection(target: AgentTarget): AgentConversation {
  const { client, handleUnauthorized } = useConnection();
  const [state, dispatch] = useReducer(reducer, undefined, emptyTranscript);
  const [connected, setConnected] = useState(false);
  const [errored, setErrored] = useState(false);

  const connectionRef = useRef<AgentConnection | null>(null);
  const attentionIdRef = useRef<string | null>(null);

  const { agent, tabId, worktreeId } = target;

  useFocusEffect(
    useCallback(() => {
      if (!client || !agent || !tabId || !worktreeId) return undefined;
      let cancelled = false;
      let backoff = INITIAL_BACKOFF_MS;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;

      dispatch({ type: "reset" });
      attentionIdRef.current = null;
      setErrored(false);

      async function run(): Promise<void> {
        if (cancelled || !client) return;
        setErrored(false);
        try {
          const connection = await client.agents.connect({ agent, tabId, worktreeId });
          if (cancelled) {
            connection.close();
            return;
          }
          connectionRef.current = connection;
          setConnected(true);
          backoff = INITIAL_BACKOFF_MS;
          for await (const event of connection) {
            if (cancelled) break;
            dispatch({ type: "event", event });
          }
        } catch (error) {
          if (cancelled) return;
          if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
            handleUnauthorized();
            return;
          }
          setConnected(false);
          setErrored(true);
          retryTimer = setTimeout(() => void run(), backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          return;
        }
        // Stream ended cleanly (server closed): retry after a beat.
        if (!cancelled) {
          setConnected(false);
          retryTimer = setTimeout(() => void run(), backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }

      void run();

      return () => {
        cancelled = true;
        if (retryTimer) clearTimeout(retryTimer);
        connectionRef.current?.close();
        connectionRef.current = null;
        setConnected(false);
      };
    }, [client, agent, tabId, worktreeId, handleUnauthorized]),
  );

  // Buzz once each time a fresh attention request appears.
  const incomingId = state.attention?.requestId ?? null;
  if (incomingId !== attentionIdRef.current) {
    attentionIdRef.current = incomingId;
    if (incomingId) hapticWarning();
  }

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch({ type: "localInput", text: trimmed, ts: Date.now() });
    void connectionRef.current?.send(trimmed);
  }, []);

  const interrupt = useCallback(() => {
    void connectionRef.current?.interrupt();
  }, []);

  const decide = useCallback((requestId: string, approved: boolean) => {
    if (approved) hapticSuccess();
    else hapticWarning();
    void connectionRef.current?.decide(requestId, approved);
  }, []);

  const answer = useCallback((requestId: string, reply: string | null) => {
    if (reply === null) hapticWarning();
    else hapticSuccess();
    void connectionRef.current?.answer(requestId, reply);
  }, []);

  const rows = transcriptRows(state);
  const phase: ChatConnectionState = errored
    ? "error"
    : !connected
      ? "connecting"
      : rows.length === 0
        ? "empty"
        : "open";

  return { rows, attention: state.attention, phase, send, interrupt, decide, answer };
}
