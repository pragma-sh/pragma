/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions -- a media surface is not a widget, but it must take focus to receive zoom shortcuts; the rules are off for this file alone so they keep guarding the rest of the viewer. */
import type { KeyboardEvent, ReactNode } from "react";

/**
 * Focusable frame around the media. Keyboard shortcuts hang off it rather than
 * off `window` so they only fire for the viewer the user is looking at.
 */
export function MediaKeyboardSurface({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col outline-none" onKeyDown={onKeyDown} tabIndex={0}>
      {children}
    </div>
  );
}
