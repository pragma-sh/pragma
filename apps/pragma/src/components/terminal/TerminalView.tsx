import { memo, useEffect, useRef } from "react";

import type { Tab } from "@pragma/constants";
import "@xterm/xterm/css/xterm.css";

import { terminalManager } from "@/lib/terminal-manager";

interface TerminalViewProps {
  tab: Tab;
  cwd: string;
}

function TerminalViewComponent({ tab, cwd }: TerminalViewProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    terminalManager.mount(tab, cwd, element);
    const observer = new ResizeObserver(() => terminalManager.resize(tab.id));
    observer.observe(element);
    return () => observer.disconnect();
    // `tab` identity changes on every project refresh; the id is the stable
    // terminal key, so depend on it (and cwd) to avoid needless re-subscribes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on tab.id, not the tab object identity.
  }, [cwd, tab.id]);

  return <div className="h-full w-full p-2 [&_.xterm]:h-full" ref={ref} />;
}

/** xterm owns its own DOM; tab title updates should not re-render the terminal. */
export const TerminalView = memo(
  TerminalViewComponent,
  (previous, next) => previous.cwd === next.cwd && previous.tab.id === next.tab.id,
);
