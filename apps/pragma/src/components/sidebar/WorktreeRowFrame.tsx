import { forwardRef, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Class for a worktree row's container, highlighting the selected one. */
function worktreeRowClass(selected: boolean): string {
  return selected
    ? "bg-sidebar-accent text-sidebar-accent-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-accent/70";
}

interface WorktreeRowFrameProps extends ComponentPropsWithoutRef<"div"> {
  depth: number;
  selected: boolean;
  disabled?: boolean;
  caret: ReactNode;
  onActivate: () => void;
  onDoubleActivate?: () => void;
  icon: ReactNode;
  label: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
  /**
   * Extra lines under the title line (agents, PR, git actions) in the
   * detailed sidebar layout. The title line itself never changes shape.
   */
  details?: ReactNode;
}

/**
 * Controls inside a card that act on their own: the title button, caret,
 * hover actions, rename input, and each agent line (which opens its tab).
 */
const OWN_CLICK_SELECTOR = "button, a, input, textarea, select, [role='button']";

/**
 * Whether a click landed on the card's body: inside its DOM (React bubbles
 * clicks out of portals, such as a dialog the row opened) and not on one of
 * its own controls.
 */
function clickedCardBody(event: MouseEvent<HTMLDivElement>): boolean {
  const { target, currentTarget } = event;
  return (
    target instanceof Element &&
    currentTarget.contains(target) &&
    target.closest(OWN_CLICK_SELECTOR) === null
  );
}

/** Left inset of a row's content at `depth`, in px. */
function rowInset(depth: number): number {
  return 8 + depth * 14;
}

/**
 * Left inset of the details area: past the caret slot (`w-3`) and its gap, so
 * details line up under the row's icon rather than under the caret.
 */
function detailsInset(depth: number): number {
  return rowInset(depth) + 12 + 4;
}

/**
 * The shared visual shell for a sidebar worktree row: an indented container
 * with a caret slot, a clickable primary area (icon + label + status dot), and
 * a trailing slot for indicators and actions. Used by both ordinary worktree
 * rows and fanout attempt rows so the two read identically.
 */
export const WorktreeRowFrame = forwardRef<HTMLDivElement, WorktreeRowFrameProps>(
  function WorktreeRowFrame(
    {
      depth,
      selected,
      disabled,
      caret,
      onActivate,
      onDoubleActivate,
      icon,
      label,
      status,
      trailing,
      details,
      className,
      style,
      ...props
    },
    ref,
  ) {
    const titleLine = (
      <>
        {caret}
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
          disabled={disabled}
          type="button"
          onClick={onActivate}
          onDoubleClick={onDoubleActivate}
        >
          {icon}
          {label}
        </button>
        {trailing}
        {/* The status slot is last and fixed-width, so dots land on the same
            column on every row no matter how many trailing indicators a row
            carries — and the label truncates against it instead of under it. */}
        <span className="flex w-2 shrink-0 items-center justify-center">{status}</span>
      </>
    );
    // A fixed height keeps every title line the same size whether or not its
    // hover-revealed `size-6` actions (pin, new-child, delete) are showing, so
    // hovering one row never nudges the rows below it.
    if (!details) {
      return (
        <div
          ref={ref}
          className={cn(
            "group flex h-8 items-center gap-1 rounded-lg px-2 text-sm",
            worktreeRowClass(selected),
            className,
          )}
          style={{ ...style, paddingLeft: rowInset(depth) }}
          {...props}
        >
          {titleLine}
        </div>
      );
    }
    return (
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer-only enlargement of the title button, which stays the keyboard and screen-reader target; a role here would nest interactive controls.
      <div
        ref={ref}
        className={cn(
          // A faint fill and hairline border set each detailed row apart as a
          // card, so its agent and PR lines read as belonging to its title.
          "group rounded-lg bg-sidebar-accent/30 text-sm ring-1 ring-sidebar-border ring-inset",
          worktreeRowClass(selected),
          !disabled && "cursor-pointer",
          className,
        )}
        style={style}
        {...props}
        // The whole card selects the worktree, not just its title. Clicks on
        // the card's own controls are theirs alone — an agent line still opens
        // its tab without the worktree selection racing it.
        onClick={(event) => {
          props.onClick?.(event);
          if (event.defaultPrevented || disabled || !clickedCardBody(event)) return;
          onActivate();
        }}
      >
        <div className="flex h-8 items-center gap-1 px-2" style={{ paddingLeft: rowInset(depth) }}>
          {titleLine}
        </div>
        <div
          className="flex flex-col gap-1 pr-4 pb-1.5"
          data-slot="worktree-row-details"
          style={{ paddingLeft: detailsInset(depth) }}
        >
          {details}
        </div>
      </div>
    );
  },
);
