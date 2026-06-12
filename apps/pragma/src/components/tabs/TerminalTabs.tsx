import { Plus, X } from "lucide-react";
import { useWorkspace } from "@/state/workspace-context";
import { modifierLabel } from "@/lib/platform";

interface Props {
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
}

export function TerminalTabs({ onCreateTab, onCloseTab }: Props) {
  const { state, dispatch } = useWorkspace();

  return (
    <div className="flex items-center gap-1 border-b px-2 pt-1.5 pb-0">
      {state.tabs.map((tab) => (
        <div
          key={tab.id}
          className={`group flex items-center gap-2 rounded-t-md border border-b-0 text-xs ${
            tab.id === state.activeTabId
              ? "bg-background font-medium"
              : "bg-muted/40 text-muted-foreground hover:bg-muted"
          }`}
        >
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_ACTIVE_TAB", tabId: tab.id })}
            className="cursor-pointer px-3 py-1.5"
          >
            {tab.title ?? `Terminal ${state.tabs.indexOf(tab) + 1}`}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            className="rounded p-0.5 pr-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onCreateTab}
        className="ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent"
        title="New tab"
      >
        <Plus className="size-3.5" />
      </button>
      <span className="ml-auto pb-1 text-[10px] text-muted-foreground">
        {modifierLabel}Tab cycles
      </span>
    </div>
  );
}
