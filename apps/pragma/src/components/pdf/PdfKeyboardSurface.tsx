/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions -- a document surface is not a widget, but it must take focus to receive the zoom shortcuts; the rules are off for this file alone so they keep guarding the rest of the viewer. */
import type { KeyboardEvent, ReactNode } from "react";

/**
 * Focusable frame around the document. Keyboard shortcuts hang off it rather
 * than off `window` so they only fire for the viewer the user is looking at —
 * several PDFs can be open at once in split panes.
 */
export function PdfKeyboardSurface({
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
