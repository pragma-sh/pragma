/**
 * Human-readable reasons a browser refused to decode or play media. Codes are
 * the `MediaError.MEDIA_ERR_*` values, spelled numerically so the table stays
 * usable under jsdom (where the `MediaError` global may be absent).
 */
const MEDIA_ERROR_REASONS: Record<number, string> = {
  1: "Loading was aborted.",
  2: "A network error interrupted loading.",
  3: "The file could not be decoded — it may be corrupt or truncated.",
  4: "This format or codec is not supported.",
};

/** Fallback when the element reports a failure with no usable detail. */
const UNKNOWN_MEDIA_REASON = "The file may be corrupt or use an unsupported codec.";

/** Message for an `<img>` that fired `error` — images expose no error detail. */
export const IMAGE_DECODE_ERROR =
  "This image could not be displayed — it may be corrupt or use an unsupported format.";

/** Message for a failed `<audio>` / `<video>` load or decode. */
export function describeMediaError(element: HTMLMediaElement | null): string {
  const code = element?.error?.code;
  const reason =
    (code !== undefined ? MEDIA_ERROR_REASONS[code] : undefined) ??
    element?.error?.message ??
    UNKNOWN_MEDIA_REASON;
  return `This file could not be played. ${reason}`;
}

/** Message for a rejected `HTMLMediaElement.play()` call. */
export function describePlayError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Playback was blocked by the browser. Click play again to start it.";
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Playback failed. ${detail || UNKNOWN_MEDIA_REASON}`;
}
