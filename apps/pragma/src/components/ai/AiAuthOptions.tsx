import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AiAuthMethod,
  type AiLoginEvent,
  aiAuthMethods,
  aiLogin,
  aiLoginCancel,
  aiLoginRespond,
  aiSetApiKey,
} from "@/lib/tauri";
import { openExternal } from "@/lib/open-external";
import { useAi } from "@/state/ai-context";

/** Which sub-view of the auth flow is showing. */
type View =
  | { kind: "list" }
  | { kind: "api-key"; method: AiAuthMethod }
  | { kind: "oauth"; method: AiAuthMethod }
  | { kind: "success"; method: AiAuthMethod };

/**
 * The reusable AI sign-in surface: featured providers up front, the rest behind
 * a "More options" reveal, an API-key form, and a streamed OAuth walkthrough.
 * On every successful add it calls `refresh()` and offers "Add another"; the
 * modal owns the final Done / Skip actions.
 */
export function AiAuthOptions({
  onProviderAuthScreenChange,
}: {
  onProviderAuthScreenChange?: (active: boolean) => void;
}) {
  const { refresh } = useAi();
  const [methods, setMethods] = useState<AiAuthMethod[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    aiAuthMethods().then(
      (loaded) => setMethods(Array.isArray(loaded) ? loaded : []),
      () => toast.error("Could not load AI sign-in options."),
    );
  }, []);

  const onAuthed = useCallback(
    async (method: AiAuthMethod) => {
      await refresh();
      setView({ kind: "success", method });
    },
    [refresh],
  );

  useEffect(() => {
    onProviderAuthScreenChange?.(view.kind === "api-key" || view.kind === "oauth");
  }, [onProviderAuthScreenChange, view.kind]);

  if (view.kind === "api-key") {
    return (
      <ApiKeyForm
        method={view.method}
        onBack={() => setView({ kind: "list" })}
        onSuccess={() => void onAuthed(view.method)}
      />
    );
  }
  if (view.kind === "oauth") {
    return (
      <OAuthFlow
        method={view.method}
        onBack={() => setView({ kind: "list" })}
        onSuccess={() => void onAuthed(view.method)}
      />
    );
  }
  if (view.kind === "success") {
    return (
      <div className="flex w-full flex-col gap-3 text-center">
        <p className="text-sm text-foreground">
          Connected <span className="font-medium">{view.method.label}</span>.
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={() => setView({ kind: "list" })} size="sm" variant="outline">
            Add another provider
          </Button>
        </div>
      </div>
    );
  }

  const featured = methods.filter((method) => method.featured);
  const more = methods.filter((method) => !method.featured);
  const select = (method: AiAuthMethod) =>
    setView(method.kind === "oauth" ? { kind: "oauth", method } : { kind: "api-key", method });

  return (
    <div className="flex min-h-0 w-full flex-col gap-3">
      <div
        className="min-h-0 max-h-[min(22rem,40vh)] overflow-y-auto pr-1"
        data-testid="ai-provider-list"
      >
        <div className="flex flex-col gap-2">
          {featured.map((method) => (
            <MethodButton
              key={`${method.kind}:${method.provider}`}
              method={method}
              onSelect={select}
            />
          ))}
          {showAll ? (
            <>
              <div className="my-1 text-xs font-medium text-muted-foreground">All providers</div>
              {more.map((method) => (
                <MethodButton
                  key={`${method.kind}:${method.provider}`}
                  method={method}
                  onSelect={select}
                />
              ))}
            </>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {!showAll && more.length > 0 ? (
          <Button
            className="mx-auto h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAll(true)}
            variant="link"
          >
            More options
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MethodButton({
  method,
  onSelect,
}: {
  method: AiAuthMethod;
  onSelect: (method: AiAuthMethod) => void;
}) {
  return (
    <Button
      className="h-9 w-full justify-between"
      onClick={() => onSelect(method)}
      size="sm"
      variant="outline"
    >
      <span className="truncate">{method.label}</span>
      <span className="text-xs text-muted-foreground">
        {method.kind === "oauth" ? "Sign in" : "API key"}
      </span>
    </Button>
  );
}

function ApiKeyForm({
  method,
  onBack,
  onSuccess,
}: {
  method: AiAuthMethod;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = key.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const status = await aiSetApiKey(method.provider, trimmed);
      if (status.available || status.signedIn.includes(method.provider)) {
        onSuccess();
      } else {
        toast.error("That key was saved but no usable model is available for it.");
        onSuccess();
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }, [key, saving, method.provider, onSuccess]);

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Paste your <span className="font-medium text-foreground">{method.label}</span>.
      </p>
      <Input
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(event) => setKey(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="API key"
        spellCheck={false}
        type="password"
        value={key}
      />
      <div className="flex gap-2">
        <Button className="flex-1" disabled={saving} onClick={onBack} size="sm" variant="ghost">
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={saving || key.trim().length === 0}
          onClick={() => void submit()}
          size="sm"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** React to a streamed OAuth event: open a browser, surface success, or surface an error. */
function reactToLoginEvent(
  event: AiLoginEvent,
  onSuccess: () => void,
  setError: (error: string | null) => void,
): void {
  if (event.type === "auth") {
    void openExternal(event.url);
  } else if (event.type === "device-code") {
    void openExternal(event.verificationUri);
  } else if (event.type === "result") {
    onSuccess();
  } else if (event.type === "error") {
    setError(event.error);
  }
}

/** Drives the streamed OAuth login, appending events and cleaning up on unmount. */
function useOAuthLogin(
  provider: string,
  onSuccess: () => void,
  setError: (error: string | null) => void,
  idRef: RefObject<string>,
  keyRef: RefObject<number>,
  setEvents: Dispatch<SetStateAction<Array<{ key: number; event: AiLoginEvent }>>>,
): void {
  const activeRef = useRef(true);
  // The callbacks are read through a ref so a parent re-render (a new inline
  // `onSuccess`) never re-runs the effect: restarting the flow would cancel the
  // sidecar mid-OAuth and re-open the browser.
  const handlersRef = useRef({ onSuccess, setError });
  handlersRef.current = { onSuccess, setError };
  useEffect(() => {
    activeRef.current = true;
    const id = idRef.current;
    aiLogin(id, provider, (event) => {
      if (!activeRef.current) {
        return;
      }
      setEvents((prev) => [...prev, { key: keyRef.current++, event }]);
      reactToLoginEvent(event, handlersRef.current.onSuccess, handlersRef.current.setError);
    }).catch((cause) => {
      if (activeRef.current) {
        handlersRef.current.setError(cause instanceof Error ? cause.message : "Login failed.");
      }
    });
    return () => {
      activeRef.current = false;
      void aiLoginCancel(id);
    };
  }, [provider, idRef, keyRef, setEvents]);
}

/** Derive the last event and whether we're awaiting a prompt/manual-code/select. */
function deriveLastState(events: Array<{ key: number; event: AiLoginEvent }>): {
  last: AiLoginEvent | undefined;
  awaitingInput: boolean;
  awaitingSelect: Extract<AiLoginEvent, { type: "select" }> | null;
} {
  const last = events.at(-1)?.event;
  return {
    last,
    awaitingInput: last?.type === "prompt" || last?.type === "manual-code",
    awaitingSelect: last?.type === "select" ? last : null,
  };
}

/** The prompt/manual-code input + submit button. */
function OAuthPromptInput({
  last,
  reply,
  setReply,
  sendReply,
}: {
  last: AiLoginEvent | undefined;
  reply: string;
  setReply: (value: string) => void;
  sendReply: (value: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Input
        onChange={(event) => setReply(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            sendReply(reply);
          }
        }}
        placeholder={last?.type === "prompt" ? (last.placeholder ?? "Enter value") : "Paste code"}
        value={reply}
      />
      <Button onClick={() => sendReply(reply)} size="sm">
        Submit
      </Button>
    </div>
  );
}

/** The select-event option buttons. */
function OAuthSelectOptions({
  options,
  sendReply,
}: {
  options: Extract<AiLoginEvent, { type: "select" }>["options"];
  sendReply: (value: string) => void;
}) {
  return (
    <>
      {options.map((option) => (
        <Button key={option.id} onClick={() => sendReply(option.id)} size="sm" variant="outline">
          {option.label}
        </Button>
      ))}
    </>
  );
}

function OAuthFlow({
  method,
  onBack,
  onSuccess,
}: {
  method: AiAuthMethod;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const idRef = useRef(crypto.randomUUID());
  const keyRef = useRef(0);
  const [events, setEvents] = useState<Array<{ key: number; event: AiLoginEvent }>>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);

  useOAuthLogin(method.provider, onSuccess, setError, idRef, keyRef, setEvents);

  const { last, awaitingInput, awaitingSelect } = deriveLastState(events);

  // A reply that lands on no session leaves the flow looking dead — the option
  // buttons stay up and nothing else happens — so surface the refusal instead
  // of dropping it.
  const sendReply = useCallback((value: string) => {
    aiLoginRespond(idRef.current, value, false).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not answer the sign-in prompt.");
    });
    setReply("");
  }, []);

  return (
    <div className="flex w-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Signing in to <span className="font-medium text-foreground">{method.label}</span>…
      </p>

      {events.map(({ key, event }) => (
        <OAuthEventRow event={event} key={key} />
      ))}

      {awaitingInput ? (
        <OAuthPromptInput last={last} reply={reply} sendReply={sendReply} setReply={setReply} />
      ) : null}

      {awaitingSelect ? (
        <OAuthSelectOptions options={awaitingSelect.options} sendReply={sendReply} />
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Button
        className="mx-auto h-auto p-0 text-xs text-muted-foreground"
        onClick={onBack}
        variant="link"
      >
        Cancel
      </Button>
    </div>
  );
}

function OAuthEventRow({ event }: { event: AiLoginEvent }) {
  if (event.type === "auth") {
    return (
      <Button onClick={() => void openExternal(event.url)} size="sm" variant="outline">
        <ExternalLink className="size-4" data-icon="inline-start" />
        Open sign-in page
      </Button>
    );
  }
  if (event.type === "device-code") {
    return (
      <div className="rounded-md border border-border/60 p-2 text-center text-sm">
        <div className="font-mono text-base tracking-widest">{event.userCode}</div>
        <Button
          className="mt-1 h-auto p-0 text-xs"
          onClick={() => void openExternal(event.verificationUri)}
          variant="link"
        >
          {event.verificationUri}
        </Button>
      </div>
    );
  }
  if (event.type === "progress") {
    return <p className="text-xs text-muted-foreground">{event.message}</p>;
  }
  return null;
}
