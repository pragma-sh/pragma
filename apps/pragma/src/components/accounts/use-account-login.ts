import { useCallback, useEffect, useRef, useState } from "react";

import type { AccountLogin, AccountLoginSession } from "@pragma-sh/constants";

import type { HarnessView } from "@/lib/accounts";
import { errorMessage } from "@/lib/errors";
import { browserOpenExternal } from "@/lib/tauri";
import type { ProjectAccounts } from "@/state/accounts-store";

const POLL_MS = 1000;

/** Where a sign-in is. */
export type LoginPhase = "idle" | "waiting" | "finishing" | "done" | "error";

/** A sign-in driven through the host's hidden login terminal. */
export interface AccountLoginFlow {
  phase: LoginPhase;
  session: AccountLoginSession | null;
  login: AccountLogin | null;
  error: string | null;
  begin: (harness: HarnessView) => Promise<void>;
  /** Types a pasted code (or any answer) into the login terminal. */
  send: (text: string) => Promise<void>;
  /** Tries to save the login now, for a command that stays open after signing in. */
  finish: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/**
 * Runs one sign-in: starts the plugin's login command on the host, polls its
 * terminal for printed URLs and exit, then identifies and saves the login.
 * On a remote host the first printed URL is opened here, because the host's
 * own browser is not the user's.
 */
export function useAccountLogin(store: ProjectAccounts, openUrls: boolean): AccountLoginFlow {
  const [phase, setPhase] = useState<LoginPhase>("idle");
  const [session, setSession] = useState<AccountLoginSession | null>(null);
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loginId = useRef<string | null>(null);
  const opened = useRef(false);

  const finish = useCallback(async () => {
    const id = loginId.current;
    if (!id) return;
    setPhase("finishing");
    try {
      const saved = await store.api.completeLogin(id);
      loginId.current = null;
      setLogin(saved);
      setPhase("done");
      await store.reload(true);
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }, [store]);

  useEffect(() => {
    if (phase !== "waiting") return undefined;
    const timer = setInterval(() => {
      const id = loginId.current;
      if (!id) return;
      void store.api
        .loginStatus(id)
        .then((status) => {
          setSession(status);
          const first = status.urls[0];
          if (openUrls && first && !opened.current) {
            opened.current = true;
            void browserOpenExternal(first);
          }
          if (status.exited) void finish();
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(errorMessage(cause));
          setPhase("error");
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [finish, openUrls, phase, store]);

  const begin = useCallback(
    async (harness: HarnessView) => {
      setError(null);
      setSession(null);
      setLogin(null);
      opened.current = false;
      try {
        const started = await store.api.beginLogin({
          pluginId: harness.source.pluginId,
          providerId: harness.source.providerId,
          agentId: harness.agentId,
        });
        loginId.current = started.loginId;
        setPhase("waiting");
      } catch (cause) {
        setError(errorMessage(cause));
        setPhase("error");
      }
    },
    [store],
  );

  const send = useCallback(
    async (text: string) => {
      const id = loginId.current;
      if (!id || !text) return;
      await store.api.loginInput(id, `${text}\r`);
    },
    [store],
  );

  const cancel = useCallback(async () => {
    const id = loginId.current;
    loginId.current = null;
    setPhase("idle");
    if (id) await store.api.cancelLogin(id).catch(() => undefined);
  }, [store]);

  const reset = useCallback(() => {
    loginId.current = null;
    setPhase("idle");
    setSession(null);
    setLogin(null);
    setError(null);
  }, []);

  return { phase, session, login, error, begin, send, finish, cancel, reset };
}
