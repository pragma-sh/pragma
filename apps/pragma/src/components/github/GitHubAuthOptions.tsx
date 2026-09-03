import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@iconify/react";
import { Copy, Loader2, Terminal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/open-external";
import { useGitHub } from "@/state/github-context";
import {
  type DeviceFlowStart,
  githubPollDeviceFlow,
  githubStartDeviceFlow,
  githubUseCliToken,
} from "@/lib/tauri";

/** Discriminates the device-flow walkthrough state. */
type FlowState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "awaiting"; start: DeviceFlowStart }
  | { phase: "cli" };

/**
 * The two GitHub sign-in options — OAuth device flow (recommended) and the `gh`
 * CLI (shown only when `gh` is authenticated) — plus the device-flow
 * walkthrough. Reused by both the onboarding GitHub step and the Pull Request
 * subtab's logged-out state, so the options stay identical (DRY). On success it
 * returns to idle and calls `refresh()`; the parent decides what to render next
 * — it may well keep these options mounted.
 */
export function GitHubAuthOptions({ className }: { className?: string }) {
  const { status, refresh } = useGitHub();
  const [flow, setFlow] = useState<FlowState>({ phase: "idle" });
  // Guards against applying a resolved poll/CLI result after unmount (the modal
  // closes or the subtab switches the instant auth succeeds).
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const startDeviceFlow = useCallback(async () => {
    setFlow({ phase: "starting" });
    try {
      const start = await githubStartDeviceFlow();
      if (!activeRef.current) {
        return;
      }
      setFlow({ phase: "awaiting", start });
      // Poll in the background; the backend blocks until authorized or failed.
      const user = await githubPollDeviceFlow(start.deviceCode, start.interval);
      if (!activeRef.current) {
        return;
      }
      // Back to idle before the refresh: the surface hosting these options may
      // stay mounted after a successful sign-in (the onboarding step does), and
      // a busy phase that is never cleared leaves the button spinning forever.
      setFlow({ phase: "idle" });
      toast.success(`Signed in as ${user.login}`);
      await refresh();
    } catch (cause) {
      if (activeRef.current) {
        setFlow({ phase: "idle" });
        toast.error(messageFor(cause));
      }
    }
  }, [refresh]);

  const useCliToken = useCallback(async () => {
    setFlow({ phase: "cli" });
    try {
      const user = await githubUseCliToken();
      if (!activeRef.current) {
        return;
      }
      setFlow({ phase: "idle" });
      toast.success(`Signed in as ${user.login}`);
      await refresh();
    } catch (cause) {
      if (activeRef.current) {
        setFlow({ phase: "idle" });
        toast.error(messageFor(cause));
      }
    }
  }, [refresh]);

  if (flow.phase === "awaiting") {
    return <DeviceCodePrompt className={className} start={flow.start} />;
  }

  const busy = flow.phase === "starting" || flow.phase === "cli";

  return (
    <div className={className}>
      <Button className="w-full" disabled={busy} onClick={() => void startDeviceFlow()}>
        {flow.phase === "starting" ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Icon icon="simple-icons:github" />
        )}
        Continue with GitHub
      </Button>
      {status?.ghAvailable ? (
        <Button
          className="mt-2 w-full"
          disabled={busy}
          onClick={() => void useCliToken()}
          variant="outline"
        >
          {flow.phase === "cli" ? <Loader2 className="animate-spin" /> : <Terminal />}
          Use GitHub CLI login
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Shows the device + user code while the backend polls for authorization. The
 * verification page was already opened on the user's behalf; the manual link and
 * copyable code cover the case where that failed.
 */
function DeviceCodePrompt({ className, start }: { className?: string; start: DeviceFlowStart }) {
  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(start.userCode);
      toast.success("Copied device code");
    } catch (cause) {
      toast.error(messageFor(cause));
    }
  }, [start.userCode]);

  return (
    <div className={className}>
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          Enter this code on GitHub to finish signing in:
        </p>
        <Button
          className="h-auto px-4 py-2 font-mono text-lg tracking-[0.3em] text-foreground"
          onClick={() => void copyCode()}
          variant="outline"
        >
          {start.userCode}
          <Copy className="size-4 text-muted-foreground" />
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Waiting for authorization…
        </div>
        <Button
          className="h-auto p-0 text-xs"
          onClick={() => void openExternal(start.verificationUri)}
          variant="link"
        >
          Open {start.verificationUri}
        </Button>
      </div>
    </div>
  );
}

/** Narrows an unknown thrown value to a human-readable message. */
function messageFor(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : "GitHub sign-in failed";
}
