import type { OpenPort } from "@pragma-sh/sdk";
import { PragmaGatewayError } from "@pragma-sh/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState } from "react-native";

import { useConnection } from "./connection-context";
import { portsForWorktree } from "./ports";

const POLL_MS = 2_000;

/** Focus-scoped inventory of listeners owned by one worktree's terminals. */
export function useOpenPorts(worktreeId: string): OpenPort[] {
  const { client, handleUnauthorized, status } = useConnection();
  const [ports, setPorts] = useState<OpenPort[]>([]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let timer: ReturnType<typeof setInterval> | undefined;

      const refresh = async (): Promise<void> => {
        if (!client || status !== "paired" || !worktreeId) return;
        try {
          const next = portsForWorktree(await client.ports.list([worktreeId]), worktreeId);
          if (active) setPorts(next);
        } catch (error) {
          if (error instanceof PragmaGatewayError && error.httpStatus === 401) {
            handleUnauthorized();
          }
        }
      };
      const start = (): void => {
        if (timer) return;
        void refresh();
        timer = setInterval(() => void refresh(), POLL_MS);
      };
      const stop = (): void => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };

      if (AppState.currentState === "active") start();
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") start();
        else stop();
      });
      return () => {
        active = false;
        stop();
        subscription.remove();
      };
    }, [client, handleUnauthorized, status, worktreeId]),
  );

  return ports;
}
