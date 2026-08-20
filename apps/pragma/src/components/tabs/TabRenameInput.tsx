import type { TabRenameApi } from "@/components/tabs/use-tab-rename";
import { commitOnEnterCancelOnEscape } from "@/lib/keyboard";
import { cn } from "@/lib/utils";

/** The inline rename field a tab shows in place of its title while renaming. */
export function TabRenameInput({
  className,
  rename,
}: {
  className?: string;
  rename: TabRenameApi;
}) {
  return (
    <input
      ref={rename.inputRef}
      aria-label="Rename tab"
      className={cn(
        "text-foreground ring-ring relative w-0 min-w-0 flex-1 rounded bg-muted px-1 text-left outline-none ring-1",
        className,
      )}
      value={rename.renameValue}
      onChange={(event) => rename.setRenameValue(event.target.value)}
      onKeyDown={commitOnEnterCancelOnEscape(rename.commitRename, rename.cancelRename)}
      onBlur={rename.commitRename}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
