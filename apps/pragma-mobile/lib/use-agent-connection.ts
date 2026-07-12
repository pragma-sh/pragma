import type { AgentConnection } from "@pragma/sdk";
import { PragmaGatewayError } from "@pragma/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useReducer, useRef, useState, type Dispatch, type RefObject } from "react";

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
  initialMessage?: string;
  initialMessageTs?: number;
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
  | { type: "reset"; initialMessage?: string; initialMessageTs?: number }
  | { type: "event"; event: Parameters<typeof applyEvent>[1] }
  | { type: "localInput"; text: string; ts: number };

function reducer(state: TranscriptState, action: StoreAction): TranscriptState {
  switch (action.type) {
    case "reset":
      return action.initialMessage && action.initialMessageTs
        ? applyLocalInput(emptyTranscript(), action.initialMessage, action.initialMessageTs)
        : emptyTranscript();
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

  const { agent, initialMessage, initialMessageTs, tabId, worktreeId } = target;

  useFocusedConnection(
    client,
    { agent, initialMessage, initialMessageTs, tabId, worktreeId },
    connectionRef,
    attentionIdRef,
    dispatch,
    setConnected,
    setErrored,
    handleUnauthorized,
  );

  // Buzz once each time a fresh attention request appears.
  const incomingId = state.attention?.requestId ?? null;
  notifyNewAttention(attentionIdRef, incomingId);

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
  const phase = chatPhase(errored, connected, rows);

  return { rows, attention: state.attention, phase, send, interrupt, decide, answer };
}

type ConnectionClient = NonNullable<ReturnType<typeof useConnection>["client"]>;
type DispatchAction = Dispatch<StoreAction>;

function useFocusedConnection(
  client: ConnectionClient | null,
  target: AgentTarget,
  connectionRef: RefObject<AgentConnection | null>,
  attentionIdRef: RefObject<string | null>,
  dispatch: DispatchAction,
  setConnected: (connected: boolean) => void,
  setErrored: (errored: boolean) => void,
  onUnauthorized: () => void,
): void {
  const { agent, initialMessage, initialMessageTs, tabId, worktreeId } = target;
  useFocusEffect(
    useCallback(
      () =>
        focusedConnectionEffect(
          client,
          { agent, initialMessage, initialMessageTs, tabId, worktreeId },
          connectionRef,
          attentionIdRef,
          dispatch,
          setConnected,
          setErrored,
          onUnauthorized,
        ),
      [
        agent,
        attentionIdRef,
        client,
        connectionRef,
        dispatch,
        initialMessage,
        initialMessageTs,
        onUnauthorized,
        setConnected,
        setErrored,
        tabId,
        worktreeId,
      ],
    ),
  );
}

function focusedConnectionEffect(
  client: ConnectionClient | null,
  target: AgentTarget,
  connectionRef: RefObject<AgentConnection | null>,
  attentionIdRef: RefObject<string | null>,
  dispatch: DispatchAction,
  setConnected: (connected: boolean) => void,
  setErrored: (errored: boolean) => void,
  onUnauthorized: () => void,
): (() => void) | undefined {
  if (!client || missingTargetPart(target)) return undefined;
  return startConnection(
    client,
    target,
    connectionRef,
    attentionIdRef,
    dispatch,
    setConnected,
    setErrored,
    onUnauthorized,
  );
}

function missingTargetPart({ agent, tabId, worktreeId }: AgentTarget): boolean {
  return [agent, tabId, worktreeId].some((part) => !part);
}

function startConnection(
  client: ConnectionClient,
  target: AgentTarget,
  connectionRef: RefObject<AgentConnection | null>,
  attentionIdRef: RefObject<string | null>,
  dispatch: DispatchAction,
  setConnected: (connected: boolean) => void,
  setErrored: (errored: boolean) => void,
  onUnauthorized: () => void,
): () => void {
  let cancelled = false;
  let backoff = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  dispatch({
    type: "reset",
    initialMessage: target.initialMessage,
    initialMessageTs: target.initialMessageTs,
  });
  attentionIdRef.current = null;
  setErrored(false);
  const retry = (): void => {
    retryTimer = setTimeout(() => void run(), backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };
  const run = async (): Promise<void> => {
    setErrored(false);
    const result = await streamConnection(
      client,
      target,
      connectionRef,
      dispatch,
      () => cancelled,
      () => {
        setConnected(true);
        setErrored(false);
        backoff = INITIAL_BACKOFF_MS;
      },
    );
    if (cancelled) return;
    if (handleStreamResult(result, onUnauthorized, setErrored)) return;
    setConnected(false);
    retry();
  };
  void run();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnected(false);
  };
}

function handleStreamResult(
  result: "closed" | "error" | "unauthorized",
  onUnauthorized: () => void,
  setErrored: (errored: boolean) => void,
): boolean {
  if (result === "unauthorized") {
    onUnauthorized();
    return true;
  }
  if (result === "error") setErrored(true);
  return false;
}

async function streamConnection(
  client: ConnectionClient,
  target: AgentTarget,
  connectionRef: RefObject<AgentConnection | null>,
  dispatch: DispatchAction,
  isCancelled: () => boolean,
  onConnected: () => void,
): Promise<"closed" | "error" | "unauthorized"> {
  const connection = await openConnection(client, target);
  if (typeof connection === "string") return connection;
  return consumeConnection(connection, connectionRef, dispatch, isCancelled, onConnected);
}

async function openConnection(
  client: ConnectionClient,
  target: AgentTarget,
): Promise<AgentConnection | "error" | "unauthorized"> {
  try {
    return await client.agents.connect(target);
  } catch (error) {
    return connectionFailure(error);
  }
}

function connectionFailure(error: unknown): "error" | "unauthorized" {
  return error instanceof PragmaGatewayError && error.httpStatus === 401 ? "unauthorized" : "error";
}

async function consumeConnection(
  connection: AgentConnection,
  connectionRef: RefObject<AgentConnection | null>,
  dispatch: DispatchAction,
  isCancelled: () => boolean,
  onConnected: () => void,
): Promise<"closed"> {
  if (isCancelled()) {
    connection.close();
    return "closed";
  }
  connectionRef.current = connection;
  onConnected();
  for await (const event of connection) {
    if (isCancelled()) break;
    dispatch({ type: "event", event });
  }
  return "closed";
}

function notifyNewAttention(ref: RefObject<string | null>, incomingId: string | null): void {
  if (incomingId === ref.current) return;
  ref.current = incomingId;
  if (incomingId) hapticWarning();
}

function chatPhase(
  errored: boolean,
  connected: boolean,
  rows: TranscriptRow[],
): ChatConnectionState {
  if (errored) return "error";
  if (!connected) return "connecting";
  return rows.length === 0 ? "empty" : "open";
}
