import type { OpenPort, PragmaClient } from "@pragma-sh/sdk";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState } from "react-native";

import { useConnection } from "./connection-context";
import { settle } from "./host-read";
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

      const read = portsReader(client, status === "paired", worktreeId, handleUnauthorized);
      const refresh = async (): Promise<void> => {
        const next = await read();
        if (active && next) setPorts(next);
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

/** Reads the worktree's ports, or null when there is no host to ask or the read failed. */
function portsReader(
  client: PragmaClient | null,
  paired: boolean,
  worktreeId: string,
  onUnauthorized: () => void,
): () => Promise<OpenPort[] | null> {
  if (!client || !paired || !worktreeId) return async () => null;
  return async () => {
    const result = await settle(client.ports.list([worktreeId]), onUnauthorized);
    return result.ok ? portsForWorktree(result.value, worktreeId) : null;
  };
}
