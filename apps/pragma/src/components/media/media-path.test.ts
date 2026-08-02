import { describe, expect, it } from "vitest";

import { isMediaPath, mediaKind, mediaMimeType } from "@/components/media/media-path";

describe("media-path", () => {
  it("routes common raster images to the image viewer", () => {
    expect(mediaKind("shots/hero.PNG")).toBe("image");
    expect(isMediaPath("a/b/photo.jpeg")).toBe(true);
    expect(mediaMimeType("photo.webp")).toBe("image/webp");
  });

  it("routes video and audio extensions to their surfaces", () => {
    expect(mediaKind("clip.mp4")).toBe("video");
    expect(mediaKind("track.MP3")).toBe("audio");
    expect(mediaMimeType("track.flac")).toBe("audio/flac");
    expect(mediaMimeType("clip.webm")).toBe("video/webm");
  });

  it("leaves SVG and source files with the code editor", () => {
    expect(isMediaPath(null)).toBe(false);
    expect(isMediaPath("icon.svg")).toBe(false);
    expect(isMediaPath("notes.md")).toBe(false);
    expect(isMediaPath("photo.png.txt")).toBe(false);
    expect(mediaKind("logo.SVG")).toBeNull();
  });
});
