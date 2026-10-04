import { ImageResponse } from "next/og";

import { PROJECT_FRAME_COLOR, TREEMAP_BACKGROUND } from "@pragma-sh/treemap";

import { layoutStorageCover, PROJECT_FRAME_WIDTH, STORAGE_COVER_SIZE } from "@/lib/storage-cover";

export const dynamic = "force-static";

/** Offset that centers each project's frame line in its black gutter. */
const FRAME_OFFSET = PROJECT_FRAME_WIDTH / 2;

/** The Pragma 1.1 cover: a GrandPerspective-style treemap, drawn like Settings → Storage. */
export function GET() {
  const { tiles, frames } = layoutStorageCover();

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        background: TREEMAP_BACKGROUND,
      }}
    >
      {tiles.map((tile) => (
        <div
          key={`${tile.x}:${tile.y}`}
          style={{
            position: "absolute",
            left: tile.x,
            top: tile.y,
            width: tile.width,
            height: tile.height,
            backgroundImage: `linear-gradient(${tile.angle}deg, ${tile.stops
              .map((stop) => `${stop.color} ${stop.offset * 100}%`)
              .join(", ")})`,
          }}
        />
      ))}
      {frames.map((frame) => (
        <div
          key={`frame:${frame.x}:${frame.y}`}
          style={{
            position: "absolute",
            left: frame.x + FRAME_OFFSET,
            top: frame.y + FRAME_OFFSET,
            width: frame.width - FRAME_OFFSET * 2,
            height: frame.height - FRAME_OFFSET * 2,
            border: `${PROJECT_FRAME_WIDTH}px solid ${PROJECT_FRAME_COLOR}`,
          }}
        />
      ))}
    </div>,
    STORAGE_COVER_SIZE,
  );
}
