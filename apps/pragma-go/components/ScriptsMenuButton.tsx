import { router } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, type ColorValue } from "react-native";

import { IconSymbol } from "@/components/IconSymbol";
import { MenuView, type MenuAction } from "@/components/ui/menu-view";
import { hapticImpact, hapticWarning } from "@/lib/haptics";
import { useScripts } from "@/lib/use-scripts";

/** Menu ids that are actions rather than a script name. */
const STOP_PREFIX = "stop:";

/**
 * The header's play control: the project's named run scripts.
 *
 * Selecting a script starts it — or, when it is already going, opens the run it
 * already has rather than starting a second one. A run with several commands
 * opens its first terminal; the rest are rows in the worktree's Terminals
 * section, because a split is a desktop layout and a phone has no room for one.
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

  const openTerminal = (tabId: string): void => {
    router.push({ pathname: "/terminal/[tabId]", params: { tabId, worktreeId } });
  };

  const choose = (id: string): void => {
    if (busy) return;
    hapticImpact();
    setBusy(true);
    const stopping = id.startsWith(STOP_PREFIX);
    const action = stopping
      ? scripts.stop(id.slice(STOP_PREFIX.length))
      : scripts.run(id).then((run) => {
          const first = run.tabIds[0];
          if (first) openTerminal(first);
          return undefined;
        });
    void action
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
  if (list.error) {
    return [{ id: "error", title: list.error, attributes: { disabled: true, destructive: true } }];
  }
  if (list.scripts.length === 0) {
    return [{ id: "none", title: "No project scripts", attributes: { disabled: true } }];
  }
  return list.scripts.flatMap((script): MenuAction[] => {
    const running = script.run;
    const suffix = script.commandCount > 1 ? ` (${script.commandCount} terminals)` : "";
    const open: MenuAction = {
      id: script.name,
      title: running ? `Open ${script.name}` : `${script.name}${suffix}`,
      state: running ? "on" : undefined,
    };
    return running
      ? [
          open,
          {
            id: `${STOP_PREFIX}${running.runId}`,
            title: `Stop ${script.name}`,
            attributes: { destructive: true },
          },
        ]
      : [open];
  });
}
