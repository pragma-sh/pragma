import type {
  Fanout,
  FanoutMember,
  FanoutPickResult,
  FanoutSendTarget,
} from "@pragma-sh/constants";
import { memberLabel } from "@pragma-sh/fanout-view";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { fanoutFailureMessage, isCleanPick, pickNotice, summarizeReceipts } from "./fanout-form";
import { useFanouts } from "./fanouts-context";
import { hapticSuccess, hapticWarning } from "./haptics";

/** Which action is running, so only its button shows progress. */
export type FanoutBusy = { kind: "pick" | "retry"; memberId: string } | { kind: "cancel" | "send" };

/** Outcome of a send, summarised for the composer. */
export interface SendSummary {
  delivered: number;
  failed: number;
}

/**
 * Fanout actions with the confirmations a phone needs.
 *
 * The SDK deliberately leaves confirming to the caller — `pick` has no
 * confirmation flag — so every destructive or disruptive step asks here first:
 * a pick deletes every attempt worktree, a retry stops the agent that is
 * running, a cancel stops all of them. A send does not ask; it only types.
 */
export function useFanoutActions(fanout: Fanout | undefined): {
  busy: FanoutBusy | null;
  pick: (member: FanoutMember, onPicked: (result: FanoutPickResult) => void) => void;
  retry: (member: FanoutMember) => void;
  cancel: () => void;
  send: (message: string, target: FanoutSendTarget) => Promise<SendSummary | null>;
} {
  const { client, handleError } = useFanouts();
  const [busy, setBusy] = useState<FanoutBusy | null>(null);

  const run = useCallback(
    async <T>(state: FanoutBusy, title: string, action: () => Promise<T>): Promise<T | null> => {
      setBusy(state);
      try {
        return await action();
      } catch (error) {
        handleError(error);
        hapticWarning();
        Alert.alert(title, fanoutFailureMessage(error, "The host could not complete this."));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [handleError],
  );

  const pick = useCallback(
    (member: FanoutMember, onPicked: (result: FanoutPickResult) => void) => {
      if (!client || !fanout) return;
      Alert.alert(
        `Pick ${memberLabel(member)}?`,
        "Its work is committed and merged into the fanout's branch. Then every attempt worktree " +
          "and branch is deleted, this one included. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Pick and merge",
            style: "destructive",
            onPress: () =>
              void run({ kind: "pick", memberId: member.id }, "Couldn't pick", () =>
                client.fanouts.pick({ fanoutId: fanout.id, memberId: member.id }),
              ).then((result) => {
                if (!result) return undefined;
                reportPick(result);
                onPicked(result);
                return undefined;
              }),
          },
        ],
      );
    },
    [client, fanout, run],
  );

  const retry = useCallback(
    (member: FanoutMember) => {
      if (!client || !fanout) return;
      Alert.alert(
        `Retry ${memberLabel(member)}?`,
        "Its agent is stopped and started again with the original prompt, in the same worktree. " +
          "Work already in the worktree is kept.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Retry",
            onPress: () =>
              void run({ kind: "retry", memberId: member.id }, "Couldn't retry", () =>
                client.fanouts.retry({ fanoutId: fanout.id, memberId: member.id }),
              ).then((result) => {
                if (result) hapticSuccess();
                return undefined;
              }),
          },
        ],
      );
    },
    [client, fanout, run],
  );

  const cancel = useCallback(() => {
    if (!client || !fanout) return;
    Alert.alert(
      "Cancel this fanout?",
      "Every attempt's agent is stopped. The attempt worktrees stay on disk, so their work is not lost.",
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Cancel fanout",
          style: "destructive",
          onPress: () =>
            void run({ kind: "cancel" }, "Couldn't cancel", () =>
              client.fanouts.cancel({ fanoutId: fanout.id }),
            ).then((result) => {
              if (result) hapticSuccess();
              return undefined;
            }),
        },
      ],
    );
  }, [client, fanout, run]);

  const send = useCallback(
    async (message: string, target: FanoutSendTarget): Promise<SendSummary | null> => {
      if (!client || !fanout) return null;
      const result = await run({ kind: "send" }, "Couldn't send", () =>
        client.fanouts.send({
          fanoutId: fanout.id,
          target,
          message,
          // One id per tap: a transport retry of this call cannot type it twice.
          messageId: `${fanout.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        }),
      );
      if (!result) return null;
      const summary = summarizeReceipts(result.receipts);
      notifySend(summary);
      return summary;
    },
    [client, fanout, run],
  );

  return { busy, pick, retry, cancel, send };
}

/** A send that reached every attempt feels successful; a partial one warns. */
function notifySend(summary: SendSummary): void {
  if (summary.failed === 0) hapticSuccess();
  else hapticWarning();
}

/**
 * A pick resolves even when it stopped part-way, with the stage to resume
 * from. Only `completed` is a clean finish; anything else needs the desktop.
 */
function reportPick(result: FanoutPickResult): void {
  if (isCleanPick(result)) {
    hapticSuccess();
    return;
  }
  hapticWarning();
  const notice = pickNotice(result);
  if (notice) Alert.alert(notice.title, notice.message);
}
