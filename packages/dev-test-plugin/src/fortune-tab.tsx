import { useCallback, useEffect, useState } from "react";

import { useNotify, useProject, useStoredState } from "@pragma/plugin";
import { Button, Kbd } from "@pragma/plugin/ui";

import { FORTUNES, pickFortune } from "./fortunes";

/** Browser event dispatched by the plugin shortcut command to reroll the visible fortune tab. */
export const FORTUNE_REROLL_EVENT = "pragma-dev-test-plugin:fortune-reroll";

/** Random secondary sidebar tab: shows a dev fortune and a "Reroll" button. */
export function FortuneTab() {
  const project = useProject();
  const notify = useNotify();
  const [saved, setSaved] = useStoredState<number>("dev-test-plugin.fortune.index", 0);
  const [roll, setRoll] = useState<number>(saved);

  const fortune = FORTUNES[roll] ?? pickFortune();
  const reroll = useCallback(() => {
    const next = Math.floor(Math.random() * FORTUNES.length);
    setRoll(next);
    setSaved(next);
    notify("New fortune!", { variant: "info" });
  }, [notify, setSaved]);

  useEffect(() => {
    window.addEventListener(FORTUNE_REROLL_EVENT, reroll);
    return () => window.removeEventListener(FORTUNE_REROLL_EVENT, reroll);
  }, [reroll]);

  return (
    <div style={{ padding: 12 }}>
      <h2>Fortune</h2>
      <p>Project: {project?.name ?? "None"}</p>
      <p data-testid="fortune">{fortune}</p>
      <Button variant="secondary" size="sm" onClick={reroll}>
        Reroll
      </Button>{" "}
      <Kbd>⌘K</Kbd>
    </div>
  );
}
