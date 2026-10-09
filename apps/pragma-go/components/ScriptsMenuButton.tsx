import type { ScriptList } from "@pragma-sh/sdk";
import { useState } from "react";
import { Alert, Pressable, type ColorValue } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { MenuView, type MenuAction } from "@/components/ui/menu-view";
import { hapticImpact, hapticSuccess, hapticWarning } from "@/lib/haptics";
import { useScripts } from "@/lib/use-scripts";

/** Menu ids that are actions rather than a script name. */
const STOP_PREFIX = "stop:";

/**
 * The header's play control: the project's named run scripts.
 *
 * Starting a script does **not** navigate. A dev server is something you start
 * and leave running, and jumping into its terminal takes the user off the
 * worktree they were working in — on the desktop the script simply appears as a
 * tab. Its terminals land in the worktree's Terminals section, one row per
 * command, ready to open when the output is actually wanted. Stopping is the
 * second entry this same menu grows once a script is going, so start and stop
 * are one control rather than a start button and a hunt for the right row.
 */
export function ScriptsMenuButton({
  color,
  worktreeId,
}: {
  color: ColorValue;
  worktreeId: string;
}) {
  const scripts = useScripts(worktreeId);
  const [busy, setBusy] = useState(false);

  const choose = (id: string): void => {
    if (busy) return;
    hapticImpact();
    setBusy(true);
    const stopping = id.startsWith(STOP_PREFIX);
    const action = stopping
      ? scripts.stop(id.slice(STOP_PREFIX.length))
      : scripts.run(id).then(() => undefined);
    void action
      .then(() => {
        // The only feedback a non-navigating start gets, so it is worth having:
        // the Terminals section fills in a beat later from the host snapshot.
        hapticSuccess();
        return undefined;
      })
      .catch((cause: unknown) => {
        hapticWarning();
        Alert.alert(
          stopping ? "Couldn't stop script" : "Couldn't run script",
          cause instanceof Error ? cause.message : "The host could not run this script.",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <MenuView
      actions={menuActions(scripts)}
      onPressAction={(event) => choose(event.nativeEvent.event)}
      title="Project scripts"
    >
      <Pressable accessibilityLabel="Project scripts" accessibilityRole="button" hitSlop={8}>
        <IconSymbol color={color} fallback="▶" name="play.circle" size={22} />
      </Pressable>
    </MenuView>
  );
}

/**
 * Builds the menu.
 *
 * The three empty states are deliberately different: a project with no scripts
 * says so, a config that failed to parse shows the error rather than pretending
 * there are none, and a list still loading says that instead of either.
 */
function menuActions(scripts: ReturnType<typeof useScripts>): MenuAction[] {
  const list = scripts.list;
  if (!list) {
    return [
      {
        id: "none",
        title: scripts.loading ? "Loading…" : "No project scripts",
        attributes: { disabled: true },
      },
    ];
  }
  return listActions(list);
}

function listActions(list: ScriptList): MenuAction[] {
  if (list.error) {
    return [{ id: "error", title: list.error, attributes: { disabled: true, destructive: true } }];
  }
  if (list.scripts.length === 0) {
    return [{ id: "none", title: "No project scripts", attributes: { disabled: true } }];
  }
  return list.scripts.flatMap((script): MenuAction[] => {
    const running = script.run;
    const suffix = script.commandCount > 1 ? ` (${script.commandCount} terminals)` : "";
    if (running) {
      // A running script offers only Stop: re-selecting it would start nothing
      // (the host returns the same run), so a second entry that does nothing
      // visible is worse than no entry.
      return [
        {
          id: `${STOP_PREFIX}${running.runId}`,
          title: `Stop ${script.name}`,
          state: "on",
          attributes: { destructive: true },
        },
      ];
    }
    return [{ id: script.name, title: `${script.name}${suffix}` }];
  });
}
