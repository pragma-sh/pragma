import type { KeyboardEvent, ReactNode } from "react";

import { vi } from "vitest";

import type { ActiveContextProvider } from "@/plugins/context-providers";

/**
 * A textarea stand-in for `MarkdownEditor` in dialog tests (TipTap does not
 * run under jsdom). The caret is always at the end of the text, so every change
 * is also reported as the text before the caret, and `replaceBeforeCaret`
 * rewrites the tail. Use it with
 * `vi.mock("@/components/github/MarkdownEditor", async () => ({ MarkdownEditor: (await import("@/test/prompt-editor")).MarkdownEditorStub }))`.
 */
export function MarkdownEditorStub({
  onChange,
  onKeyDown,
  onCaretTextChange,
  handleRef,
  value,
  caretPopover,
}: {
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCaretTextChange?: (text: string) => void;
  handleRef?: { current: unknown };
  value: string;
  caretPopover?: ReactNode;
}) {
  const update = (next: string) => {
    onChange(next);
    onCaretTextChange?.(next);
  };
  if (handleRef) {
    handleRef.current = {
      setMarkdown: update,
      replaceBeforeCaret: (length: number, text: string) =>
        update(value.slice(0, value.length - length) + text),
    };
  }
  return (
    <>
      <textarea
        aria-label="Prompt"
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        value={value}
      />
      {caretPopover}
    </>
  );
}

/** What the fake "Docs" provider resolves a picked item to. */
export const contextResolveMock = vi.fn();

/** The fake "Tickets" provider's search; offers nothing unless a test sets it. */
export const ticketsSearchMock = vi.fn(async (): Promise<never[]> => []);

/**
 * Fake `@` providers for `vi.mock("@/plugins/context-providers", …)`: "Docs"
 * (`auth-guide`, `billing`) and "Tickets" (driven by {@link ticketsSearchMock}).
 */
export const testContextProviders: ActiveContextProvider[] = [
  {
    key: "test:docs",
    title: "Docs",
    icon: null,
    iconUrl: null,
    itemIconUrl: () => null,
    search: async () => [
      { id: "a", displayName: "auth-guide", description: "How auth works" },
      { id: "b", displayName: "billing", description: "Billing notes" },
    ],
    resolve: (input) => contextResolveMock(input),
  },
  {
    key: "test:tickets",
    title: "Tickets",
    icon: null,
    iconUrl: null,
    itemIconUrl: () => null,
    search: () => ticketsSearchMock(),
    resolve: async () => "",
  },
];
