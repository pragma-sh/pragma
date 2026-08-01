import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Sparkles, Square } from "lucide-react";
import { Streamdown } from "streamdown";

import { errorMessage } from "@/lib/errors";
import { aiAsk, aiAskCancel, type AiAskEvent } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export interface AskAiSession {
  question: string;
  worktreeId: string;
}

interface AskAiPanelProps {
  session: AskAiSession;
  onDone: () => void;
}

type AskStatus = "running" | "done" | "error";

interface AskAiStreamState {
  answer: string;
  status: AskStatus;
  error: string | null;
  requestId: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  stop: () => void;
}

/** Drive one ask-AI sidecar stream for the current panel session. */
function useAskAiStream(session: AskAiSession): AskAiStreamState {
  const requestId = useId();
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<AskStatus>("running");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setAnswer("");
    setStatus("running");
    setError(null);

    const id = `ask-ai-${requestId}`;
    const onEvent = (event: AiAskEvent) => {
      if (cancelledRef.current) return;
      applyAskEvent(event, setAnswer, setStatus, setError);
    };

    void aiAsk(id, session.worktreeId, session.question, onEvent).catch((cause: unknown) => {
      if (cancelledRef.current) return;
      setError(errorMessage(cause));
      setStatus("error");
    });

    return () => {
      cancelledRef.current = true;
      void aiAskCancel(id);
    };
  }, [requestId, session.question, session.worktreeId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [answer]);

  return {
    answer,
    status,
    error,
    requestId,
    scrollRef,
    stop: () => {
      cancelledRef.current = true;
      void aiAskCancel(`ask-ai-${requestId}`);
    },
  };
}

/** Apply one NDJSON ask event onto the panel's answer state. */
function applyAskEvent(
  event: AiAskEvent,
  setAnswer: React.Dispatch<React.SetStateAction<string>>,
  setStatus: React.Dispatch<React.SetStateAction<AskStatus>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  switch (event.type) {
    case "delta":
      setAnswer((prev) => prev + event.text);
      return;
    case "reset":
      setAnswer("");
      return;
    case "result":
      setAnswer(event.text);
      setStatus("done");
      return;
    case "error":
      setError(event.error);
      setStatus("error");
  }
}

/**
 * Replaces the command list while a one-shot Ask AI answer streams. Escape /
 * close cancel the sidecar; the panel is one-shot (no follow-up turns).
 */
export function AskAiPanel({ session, onDone }: AskAiPanelProps) {
  const stream = useAskAiStream(session);

  return (
    <div className="flex max-h-[min(60vh,32rem)] flex-col">
      <AskAiHeader
        onStop={() => {
          stream.stop();
          onDone();
        }}
        question={session.question}
        running={stream.status === "running"}
      />
      <AskAiBody
        answer={stream.answer}
        error={stream.error}
        scrollRef={stream.scrollRef}
        status={stream.status}
      />
    </div>
  );
}

function AskAiHeader({
  question,
  running,
  onStop,
}: {
  question: string;
  running: boolean;
  onStop: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-b px-3 py-2">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">Ask AI</p>
        <p className="truncate text-sm text-foreground">{question}</p>
      </div>
      {running ? (
        <button
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onStop}
          type="button"
        >
          <Square className="size-3" />
          Stop
        </button>
      ) : null}
    </div>
  );
}

function AskAiBody({
  answer,
  status,
  error,
  scrollRef,
}: {
  answer: string;
  status: AskStatus;
  error: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" ref={scrollRef}>
      {status === "error" ? (
        <p className="text-sm text-destructive">{error ?? "Ask AI failed."}</p>
      ) : null}
      {status === "running" && !answer ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Thinking…
        </p>
      ) : null}
      {answer ? <AskAiMarkdown answer={answer} streaming={status === "running"} /> : null}
    </div>
  );
}

function AskAiMarkdown({ answer, streaming }: { answer: string; streaming: boolean }) {
  return (
    <div
      className={cn(
        "prose prose-invert prose-sm max-w-none overflow-hidden break-words text-foreground",
        "[&_code]:break-words [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words",
        "[&_table]:block [&_table]:overflow-x-auto",
      )}
    >
      <Streamdown mode={streaming ? "streaming" : "static"}>{answer}</Streamdown>
    </div>
  );
}
