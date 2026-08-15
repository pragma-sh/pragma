import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The muted-until-hover treatment every toolbar and header icon button shares.
 * Pair it with `variant="ghost"` so the icon recedes until pointed at.
 */
const TOOLBAR_BUTTON_CLASS = "text-muted-foreground hover:bg-muted hover:text-foreground";

/**
 * A `Button` that always carries a tooltip and an accessible name.
 *
 * Every icon-only control in the app goes through this component: the label is
 * written once and becomes both the hover tooltip and the `aria-label`, so the
 * two can never drift apart. Keep labels to one or two words.
 *
 * It composes like a plain `Button` — `asChild` still works, and it can be the
 * child of a Radix `*Trigger asChild` (menus, popovers, dialogs) because the
 * trigger's props and ref pass straight through to the underlying button.
 */
function IconButton({
  label,
  side,
  align,
  sideOffset,
  tooltipDisabled = false,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof Button> & {
  /** One- to two-word description of the action, e.g. "New tab". */
  label: string;
  /** Which side of the button the tooltip opens on. Defaults to Radix's `top`. */
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  align?: React.ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: React.ComponentProps<typeof TooltipContent>["sideOffset"];
  /**
   * Suppress the tooltip while keeping the accessible name — for a button whose
   * own surface already explains it (an open popover, a drag in progress).
   */
  tooltipDisabled?: boolean;
}) {
  const button = <Button aria-label={ariaLabel ?? label} size="icon" {...props} />;

  if (tooltipDisabled) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent align={align} side={side} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The same tooltip as `IconButton`, for an icon control that cannot be a
 * `Button` — a bare `<button>` carrying its own layout, or a third-party
 * trigger. The child keeps its own styling; only the tooltip is added, so the
 * child still has to carry its own `aria-label`.
 */
function IconTooltip({
  label,
  side,
  align,
  sideOffset,
  children,
}: {
  label: string;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  align?: React.ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: React.ComponentProps<typeof TooltipContent>["sideOffset"];
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent align={align} side={side} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export { IconButton, IconTooltip, TOOLBAR_BUTTON_CLASS };
