import { useEffect, useRef } from "react";

import type { Editor } from "@tiptap/react";

import type { ScratchpadRange } from "@/components/scratchpad/scratchpad-comments";

/** A picked block plus its rect inside the scroll container's content box. */
export interface PickBox extends ScratchpadRange {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Rough pill height, used to flip it above a block near the viewport floor. */
const PILL_HEIGHT = 38;
/** Gap between the picked block and the label/pill, matching the browser overlay. */
const PILL_GAP = 8;
/** Pill width reserved when clamping it inside the scroll container. */
const PILL_WIDTH = 340;

/**
 * The picker overlay: a ring-bordered box with its own tint layer, painted like
 * the in-app browser's design mode (`DESIGN_SCRIPT` in
 * `src-tauri/src/browser.rs`) minus its tag label. The box stays mounted for
 * the whole session so moving between blocks glides instead of re-mounting; it
 * lives in the scroll container's content box, so it tracks the block while the
 * surface scrolls without re-measuring.
 */
function PickHighlight({ box, selected }: { box: PickBox | null; selected: boolean }) {
  return (
    <div
      className="scratchpad-design-box"
      data-selected={selected}
      data-visible={box !== null}
      style={{
        transform: `translate(${box?.left ?? 0}px,${box?.top ?? 0}px)`,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
      }}
    >
      <div className="scratchpad-design-fill" />
    </div>
  );
}

/**
 * The comment pill: same rounded input plus circular "+" action the browser
 * design mode stages changes with, docked under the picked block and flipped
 * above it when the block sits near the bottom of the surface.
 */
function CommentPill({
  box,
  container,
  onCancel,
  onChange,
  onSubmit,
  value,
}: {
  box: PickBox;
  container: HTMLElement | null;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const below = box.top + box.height + PILL_GAP;
  const floor = (container?.scrollTop ?? 0) + (container?.clientHeight ?? 0);
  const top =
    below + PILL_HEIGHT + PILL_GAP <= floor ? below : Math.max(0, box.top - PILL_HEIGHT - PILL_GAP);
  const left = Math.max(
    PILL_GAP,
    Math.min(box.left, (container?.clientWidth ?? box.left) - PILL_WIDTH),
  );
  return (
    <form
      className="scratchpad-design-pill"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      style={{ transform: `translate(${left}px,${top}px)` }}
    >
      <input
        aria-label="Comment on this block"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Describe the change"
        ref={inputRef}
        type="text"
        value={value}
      />
      <button aria-label="Add comment" disabled={!value.trim()} type="submit">
        +
      </button>
    </form>
  );
}

/**
 * What the agent is shown as the commented-on thing. A JSX block is an atom
 * with no text, so it quotes its MDX source instead of coming back empty.
 */
export function rangeQuote(editor: Editor, range: ScratchpadRange): string {
  const text = editor.state.doc.textBetween(range.from, range.to, "\n").trim();
  if (text) return text;
  const raw: unknown = editor.state.doc.nodeAt(range.from)?.attrs.raw;
  return typeof raw === "string" ? raw : "";
}

/**
 * Everything the picker paints over the editing surface while comment mode is on:
 * the highlight box, plus the comment pill once a block has been picked.
 */
export function PickerOverlay({
  container,
  hover,
  onCancel,
  onChange,
  onSubmit,
  target,
  value,
}: {
  container: HTMLElement | null;
  hover: PickBox | null;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  target: PickBox | null;
  value: string;
}) {
  return (
    <>
      {/* One box at a time, like the browser overlay: the picked block wins over hover. */}
      <PickHighlight box={target ?? hover} selected={target !== null} />
      {target ? (
        <CommentPill
          box={target}
          container={container}
          onCancel={onCancel}
          onChange={onChange}
          onSubmit={onSubmit}
          value={value}
        />
      ) : null}
    </>
  );
}

/** Measures a picked range against the scroll container's content box. */
export function measurePick(
  editor: Editor,
  container: HTMLElement | null,
  range: ScratchpadRange | null,
): PickBox | null {
  if (!container || !range) return null;
  const dom = editor.view.nodeDOM(range.from);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  return {
    ...range,
    top: rect.top - bounds.top + container.scrollTop,
    left: rect.left - bounds.left + container.scrollLeft,
    width: rect.width,
    height: rect.height,
  };
}
