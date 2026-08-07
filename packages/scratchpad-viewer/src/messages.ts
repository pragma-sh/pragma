/**
 * The two-way contract between a native client and the scratchpad viewer
 * document it hosts in a web view. Both sides import these types, so a change
 * to one end fails to typecheck at the other.
 *
 * The shapes that also exist on disk (a block anchor, a comment) come from
 * `@pragma/scratchpad-contract` and are re-exported here so a host importing
 * the viewer still gets the whole vocabulary from one place.
 */
import type { ScratchpadBlock, ScratchpadComment } from "@pragma/scratchpad-contract";

export type { ScratchpadBlock, ScratchpadComment };

/** Messages the viewer document posts to its native host. */
export type ScratchpadViewerMessage =
  /** The document rendered; height is its full scroll height in CSS pixels. */
  | { type: "ready"; height: number }
  /** The document's height changed (a component expanded, fonts loaded). */
  | { type: "height"; height: number }
  /** MDX failed to compile or a component threw while rendering. */
  | { type: "error"; message: string }
  /** A long press is hovering a block: where the comment would land. */
  | { type: "preview"; block: ScratchpadBlock | null }
  /** A tap, or the release of a long press, chose a block to comment on. */
  | { type: "select"; block: ScratchpadBlock }
  /** A rendered component asked to prompt the attached agent. */
  | { type: "promptAgent"; requestId: string; text: string }
  /** A rendered component asked the host to attach an agent tab. */
  | { type: "requestAgentAttachment"; requestId: string }
  /** A rendered component subscribed to attached-agent progress. */
  | { type: "subscribeAgentProgress"; requestId: string; tabIds: string[] }
  /** The component's progress subscription was torn down. */
  | { type: "unsubscribeAgentProgress"; requestId: string };

/** Commands the native host sends into the viewer document. */
export type ScratchpadViewerCommand =
  /** Replaces the highlighted comment set. */
  | { type: "comments"; comments: ScratchpadComment[] }
  /** Turns the tap/long-press comment picker on or off. */
  | { type: "commentMode"; active: boolean }
  /** Clears the current selection highlight without leaving comment mode. */
  | { type: "clearSelection" }
  /** Re-themes the document in place (host theme changed). */
  | { type: "theme"; css: string; mode: "light" | "dark" }
  /** Resolves a pending {@link ScratchpadViewerMessage} request. */
  | { type: "response"; requestId: string; value?: unknown; error?: string }
  /** Delivers an agent-progress update to a subscribed component. */
  | { type: "progress"; requestId: string; entries: unknown[] };
