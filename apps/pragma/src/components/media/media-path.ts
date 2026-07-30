import { extname } from "@/lib/path";

/** Raster image extensions routed to the media viewer (SVG stays in the editor). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/** Video extensions played with a native `<video>` element. */
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi"]);

/** Audio extensions played with the themed `AudioPlayer` surface. */
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);

/** MIME type per lowercased extension for blob URLs. */
const MEDIA_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg",
};

/** Kind of media surface a path should open. */
export type MediaKind = "image" | "video" | "audio";

/** True when the file should open in the read-only media viewer instead of CodeMirror. */
export function isMediaPath(filePath: string | null): boolean {
  return mediaKind(filePath) !== null;
}

/** Resolves the media kind for a path, or `null` when the editor still owns it. */
export function mediaKind(filePath: string | null): MediaKind | null {
  if (filePath === null) return null;
  const ext = extname(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

/** MIME type for a media path's blob URL, or a generic binary type as a last resort. */
export function mediaMimeType(filePath: string): string {
  return MEDIA_MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
}
