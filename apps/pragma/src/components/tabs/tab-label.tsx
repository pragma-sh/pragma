import { useMemo, useState } from "react";

import type { Tab } from "@pragma/constants";
import { Icon } from "@iconify/react";
import { Globe, SquareTerminal } from "lucide-react";

import { fileIconId } from "@/lib/file-icons";
import { basename } from "@/lib/path";
import { useTabDirty } from "@/state/editor-dirty-store";

/** The display title for a tab: file name for editor/diff, else its label. */
export function tabTitle(tab: Tab): string {
  if ((tab.kind === "editor" || tab.kind === "diff") && tab.filePath) {
    const name = basename(tab.filePath);
    if (tab.kind === "diff") {
      const sideLabel =
        tab.diffSide === "committed"
          ? "Committed"
          : tab.diffSide === "staged"
            ? "Staged"
            : "Working";
      return `${name} (${sideLabel})`;
    }
    return name;
  }
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

  if (tab.kind === "editor" || tab.kind === "diff") {
    return <Icon className="size-3.5 shrink-0" icon={fileIconId(basename(tab.filePath ?? ""))} />;
  }

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

/** A small dot shown next to a tab's close button while it has unsaved edits. */
export function TabDirtyDot({ tabId }: { tabId: string }) {
  const dirty = useTabDirty(tabId);
  if (!dirty) {
    return null;
  }
  return (
    <output
      aria-label="Unsaved changes"
      className="block size-2 shrink-0 rounded-full bg-cyan-400"
    />
  );
}
