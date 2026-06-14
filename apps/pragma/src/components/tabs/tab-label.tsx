import { useMemo, useState } from "react";

import type { Tab } from "@pragma/constants";
import { Globe, SquareTerminal } from "lucide-react";

export function tabTitle(tab: Tab): string {
  return tab.title ?? (tab.kind === "browser" ? "New tab" : "Shell");
}

/** Renders a tab kind icon, using the page favicon for browser tabs when available. */
export function TabIcon({ tab }: { tab: Tab }) {
  const [failed, setFailed] = useState(false);
  const favicon = useMemo(() => {
    if (!tab.url || tab.kind !== "browser") {
      return null;
    }
    try {
      return new URL("/favicon.ico", tab.url).href;
    } catch {
      return null;
    }
  }, [tab.kind, tab.url]);

  if (tab.kind !== "browser") {
    return <SquareTerminal className="size-3.5 shrink-0 text-slate-400" />;
  }

  if (!favicon || failed) {
    return <Globe className="size-3.5 shrink-0 text-slate-400" />;
  }

  return (
    <img
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      src={favicon}
      onError={() => setFailed(true)}
    />
  );
}
