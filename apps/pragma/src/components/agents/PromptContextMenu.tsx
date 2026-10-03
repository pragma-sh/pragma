import { type ReactNode, useEffect, useRef } from "react";

import { AtSign, Info, Loader2 } from "lucide-react";

import { SlashCommandMenu } from "@/components/agents/AgentLaunchOptions";
import type { AgentLaunchOptionsState } from "@/hooks/use-agent-launch-options";
import type { PromptContextOption, PromptContextState } from "@/hooks/use-prompt-context";
import { cn } from "@/lib/utils";

/**
 * What an agent prompt shows under its caret: the `@` context picker while a
 * mention is typed, else the `/` command picker when `launch` has one open.
 */
export function promptCaretPopover(
  context: PromptContextState,
  launch?: AgentLaunchOptionsState | null,
): ReactNode {
  if (context.open) return <PromptContextMenu context={context} />;
  if (launch?.slashMenuOpen) return <SlashCommandMenu launch={launch} />;
  return null;
}

/** The `@` context picker shown under the prompt's caret, grouped by provider. */
function PromptContextMenu({ context }: { context: PromptContextState }) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [context.index]);
  if (!context.open) {
    return null;
  }
  let row = 0;
  return (
    <div
      aria-label="Context"
      className="max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
    >
      {context.groups.map((group) => (
        <section key={group.provider.key} aria-label={group.provider.title}>
          <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
            {group.provider.title}
          </div>
          <ul>
            {group.options.map((option) => {
              const index = row++;
              const active = index === context.index;
              return (
                <li key={option.item.id}>
                  <button
                    ref={active ? activeRef : undefined}
                    type="button"
                    aria-current={active}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                    )}
                    onMouseEnter={() => context.setIndex(index)}
                    // Keep focus in the editor so typing continues after a click.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => context.select(option)}
                  >
                    <ContextOptionIcon option={option} />
                    <span className="shrink-0 truncate font-mono text-xs">
                      {option.item.displayName}
                    </span>
                    {option.item.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {option.item.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {context.loading ? (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Searching…
        </div>
      ) : null}
      {context.notices.map((notice) => (
        <div
          key={notice}
          className="flex items-start gap-2 px-2 py-1 text-xs text-muted-foreground"
        >
          <Info className="mt-0.5 size-3 shrink-0" />
          {notice}
        </div>
      ))}
      {!context.loading && context.options.length === 0 && context.notices.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">{emptyMessage(context.query)}</div>
      ) : null}
    </div>
  );
}

/** What the picker says when no provider matched. */
function emptyMessage(query: string | null): string {
  return query
    ? `No files, issues, or pull requests match "${query}".`
    : "Type to search files, issues, and pull requests.";
}

/** The item's own icon or image, else its provider's, else a plain `@`. */
function ContextOptionIcon({ option }: { option: PromptContextOption }) {
  const { item, provider } = option;
  const className = "size-3.5 shrink-0 text-muted-foreground";
  const itemUrl = provider.itemIconUrl(item);
  if (item.icon) return <item.icon className={className} />;
  if (itemUrl) return <img src={itemUrl} alt="" className="size-3.5 shrink-0 object-contain" />;
  if (provider.icon) return <provider.icon className={className} />;
  if (provider.iconUrl) {
    return <img src={provider.iconUrl} alt="" className="size-3.5 shrink-0 object-contain" />;
  }
  return <AtSign className={className} />;
}
