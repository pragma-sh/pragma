import {
  Fragment,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
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
/**
 * Narrowest the text may be squeezed beside the icon and buttons. A toast whose
 * buttons leave less than this counts as long however short its text is, so
 * two buttons never crush a short message into a sliver.
 */
export const MIN_TOAST_TEXT_WIDTH = 200;

const HOST_ATTR = "data-pragma-toast-more";
/**
 * Sonner's own toasts. A custom JSX toast (`toast.custom`) is rendered inside
 * `[data-title]` with `data-styled="false"` and owns its layout, so it is
 * never clamped, re-laid-out, or given a Show more toggle.
 */
const STYLED_TOAST = '[data-sonner-toast][data-styled="true"]';

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
      for (const toast of document.querySelectorAll<HTMLElement>(STYLED_TOAST)) {
        const content = toast.querySelector<HTMLElement>("[data-content]");
        if (!content) continue;
        const long =
          textLength(content) > LONG_TOAST_CHARS || rowTextWidth(toast) < MIN_TOAST_TEXT_WIDTH;
        // The new layout changes the toast's height after sonner measured it.
        if (toast.toggleAttribute(LONG_TOAST_ATTR, long) !== wasLong(toast)) remeasure(toast);
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
  // The button adds a line below the text after sonner measured the toast;
  // without a re-measure, hovering expands the stack to the old height and the
  // button spills out of the toast.
  useLayoutEffect(() => {
    remeasure(toast);
  }, [toast]);
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
const longToasts = new WeakMap<HTMLElement, boolean>();

/** The long state `toast` had at the previous scan, then records the current one. */
function wasLong(toast: HTMLElement): boolean {
  const previous = longToasts.get(toast) ?? false;
  longToasts.set(toast, toast.hasAttribute(LONG_TOAST_ATTR));
  return previous;
}

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
  reissue(<>{unwrap(current.title)}</>, { ...current, id });
}

const TYPED = {
  success: sonner.success,
  error: sonner.error,
  warning: sonner.warning,
  info: sonner.info,
};

/** The title a caller passed, without the fragment `remeasure` wraps it in. */
function unwrap(title: ReactNode): ReactNode {
  return isValidElement<{ children?: ReactNode }>(title) && title.type === Fragment
    ? title.props.children
    : title;
}

/** Text sonner renders for a plain string or number; undefined for anything richer. */
function plainText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** What a rendered toast shows, to tell it apart from other live toasts. */
function renderedSignature(node: HTMLElement): string {
  const part = (selector: string) => node.querySelector(selector)?.textContent ?? "";
  return JSON.stringify([
    node.getAttribute("data-type") ?? "default",
    part("[data-title]"),
    part("[data-description]"),
  ]);
}

/**
 * The id of the live toast `node` renders. Sonner puts no id in the DOM, and
 * repeated errors share their text, so the title alone is not unique: match
 * type, title and description, then break a remaining tie by order. Sonner
 * renders newest first while `getToasts()` lists oldest first, so twins pair up
 * from the oldest end. A toast already re-issued by `remeasure` still matches.
 */
function findToastId(node: HTMLElement): string | number | undefined {
  const signature = renderedSignature(node);
  // A dismissed toast stays in the DOM while it animates out, but is no longer live.
  const twins = [
    ...document.querySelectorAll<HTMLElement>(`${STYLED_TOAST}:not([data-removed="true"])`),
  ].filter((other) => renderedSignature(other) === signature);
  const matches = sonner.getToasts().filter((entry): entry is ToastT => {
    if (!("title" in entry) || typeof entry.title === "function") return false;
    const title = plainText(unwrap(entry.title));
    if (title === undefined) return false;
    const description = entry.description === undefined ? "" : plainText(entry.description);
    return (
      description !== undefined &&
      JSON.stringify([entry.type ?? "default", title, description]) === signature
    );
  });
  const index = twins.indexOf(node);
  return index === -1 ? undefined : matches[twins.length - 1 - index]?.id;
}

function textLength(content: HTMLElement): number {
  let length = 0;
  for (const part of content.querySelectorAll("[data-title], [data-description]")) {
    length += part.textContent?.length ?? 0;
  }
  return length;
}

/**
 * Width the text would get if the icon and buttons shared its row. Built from
 * the toast's and the buttons' own widths, never the text's, so it reads the
 * same in either layout and toggling the attribute cannot oscillate. Infinite
 * for a toast with no buttons or no layout (jsdom).
 */
function rowTextWidth(toast: HTMLElement): number {
  const buttons = toast.querySelectorAll<HTMLElement>(":scope > [data-button]");
  if (buttons.length === 0 || toast.clientWidth === 0) return Number.POSITIVE_INFINITY;
  const style = getComputedStyle(toast);
  const gap = Number.parseFloat(style.columnGap) || 0;
  let width =
    toast.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  for (const sibling of toast.querySelectorAll<HTMLElement>(
    ":scope > [data-icon], :scope > [data-button]",
  )) {
    const margins = getComputedStyle(sibling);
    width -=
      sibling.offsetWidth +
      (Number.parseFloat(margins.marginLeft) || 0) +
      (Number.parseFloat(margins.marginRight) || 0) +
      gap;
  }
  return width;
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
