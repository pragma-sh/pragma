import { isValidElement, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast as sonner, type ToastT } from "sonner";

/**
 * Marks a toast whose text is long: `sonner.css` gives the text the full width
 * and moves the buttons to a row beneath it.
 */
export const LONG_TOAST_ATTR = "data-pragma-long";
/** Marks a toast the user expanded with "Show more": its text is unclamped. */
export const OPEN_TOAST_ATTR = "data-pragma-open";
/** Title plus description length past which a toast counts as long. */
export const LONG_TOAST_CHARS = 80;

const HOST_ATTR = "data-pragma-toast-more";

interface Overflowing {
  toast: HTMLElement;
  host: HTMLElement;
}

/**
 * Lays out and truncates long toasts at render time.
 *
 * Toasts are raised from ~70 call sites with plain strings, so this works on
 * sonner's own DOM (`[data-sonner-toast]`, `[data-content]`, `[data-title]`,
 * `[data-description]`) rather than asking every caller to pass a component.
 * It only adds attributes and one portal host per clipped toast; sonner keeps
 * owning the rest of the node.
 */
export function ToastOverflow() {
  const [overflowing, setOverflowing] = useState<Overflowing[]>([]);

  useEffect(() => {
    const hosts = new WeakMap<HTMLElement, HTMLElement>();
    let frame = 0;

    const scan = () => {
      frame = 0;
      const next: Overflowing[] = [];
      for (const toast of document.querySelectorAll<HTMLElement>("[data-sonner-toast]")) {
        const content = toast.querySelector<HTMLElement>("[data-content]");
        if (!content) continue;
        toast.toggleAttribute(LONG_TOAST_ATTR, textLength(content) > LONG_TOAST_CHARS);
        if (!toast.hasAttribute(OPEN_TOAST_ATTR) && !isClipped(content)) continue;
        next.push({ toast, host: hostFor(content, hosts) });
      }
      // Rendering the buttons mutates the DOM and re-triggers the observer;
      // bail out when nothing changed so that does not loop.
      setOverflowing((current) => (sameEntries(current, next) ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(scan);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return overflowing.map(({ toast, host }) =>
    createPortal(<ShowMoreButton toast={toast} />, host, keyFor(toast)),
  );
}

function ShowMoreButton({ toast }: { toast: HTMLElement }) {
  const [open, setOpen] = useState(() => toast.hasAttribute(OPEN_TOAST_ATTR));
  return (
    <button
      className="mt-1 rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-1 focus-visible:outline-ring"
      type="button"
      onClick={() => {
        toast.toggleAttribute(OPEN_TOAST_ATTR, !open);
        setOpen(!open);
        remeasure(toast);
      }}
    >
      {open ? "Show less" : "Show more"}
    </button>
  );
}

const toastIds = new WeakMap<HTMLElement, string | number>();

/**
 * Makes sonner re-measure a toast whose text was just expanded or collapsed.
 *
 * Sonner pins each toast in a hovered stack to the height it measured, and
 * measures again only when the toast's title, description, or buttons
 * change. Re-issuing the toast under its own id with the title wrapped in a
 * fresh fragment is such a change — same text, new identity — so sonner
 * re-measures through its own update path and the stack makes room.
 */
function remeasure(node: HTMLElement) {
  const id = toastIds.get(node) ?? findToastId(node);
  if (id === undefined) return;
  toastIds.set(node, id);
  const current = sonner
    .getToasts()
    .find((entry): entry is ToastT => entry.id === id && "title" in entry);
  if (!current || typeof current.title === "function") return;
  // Re-issue through the call matching the toast's type: plain `toast()`
  // resets the type, which would drop an error's icon and colours.
  const reissue = TYPED[current.type as keyof typeof TYPED] ?? sonner;
  reissue(<>{current.title}</>, { ...current, id });
}

const TYPED = {
  success: sonner.success,
  error: sonner.error,
  warning: sonner.warning,
  info: sonner.info,
};

/** The id of the live toast `node` renders, matched by its title text. */
function findToastId(node: HTMLElement): string | number | undefined {
  const title = node.querySelector("[data-title]")?.textContent ?? "";
  const match = sonner
    .getToasts()
    .find(
      (entry): entry is ToastT =>
        "title" in entry &&
        (typeof entry.title === "string" || typeof entry.title === "number") &&
        String(entry.title) === title,
    );
  return match && !isValidElement(match.title) ? match.id : undefined;
}

function textLength(content: HTMLElement): number {
  let length = 0;
  for (const part of content.querySelectorAll("[data-title], [data-description]")) {
    length += part.textContent?.length ?? 0;
  }
  return length;
}

/** Whether the line clamp in `sonner.css` is hiding part of the text. */
function isClipped(content: HTMLElement): boolean {
  return [...content.querySelectorAll<HTMLElement>("[data-title], [data-description]")].some(
    (part) => part.scrollHeight > part.clientHeight + 1,
  );
}

function hostFor(content: HTMLElement, hosts: WeakMap<HTMLElement, HTMLElement>): HTMLElement {
  const existing = hosts.get(content);
  if (existing?.isConnected) return existing;
  const host = document.createElement("span");
  host.setAttribute(HOST_ATTR, "");
  content.append(host);
  hosts.set(content, host);
  return host;
}

const keys = new WeakMap<HTMLElement, string>();
let nextKey = 0;

/** A stable portal key per toast node, so React keeps each button's state. */
function keyFor(toast: HTMLElement): string {
  let key = keys.get(toast);
  if (key === undefined) {
    nextKey += 1;
    key = `toast-more-${nextKey}`;
    keys.set(toast, key);
  }
  return key;
}

function sameEntries(a: Overflowing[], b: Overflowing[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.host === b[index]?.host);
}
