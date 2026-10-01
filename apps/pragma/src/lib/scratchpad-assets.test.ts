import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  getWhiteboard: vi.fn(async () => ({
    id: "board",
    title: "Diagram",
    worktreeId: "wt",
    version: 1,
  })),
  viewWhiteboard: vi.fn(async () => ({ data: "cG5n" })),
}));

import { inlineScratchpadAssets } from "./scratchpad-assets";

describe("scratchpad export assets", () => {
  it("inlines Markdown images, reference images, JSX media, and whiteboards without changing links", async () => {
    const image = { type: "image", url: "./image.png" };
    const definition = { type: "definition", identifier: "diagram", url: "./diagram.svg" };
    const link = { type: "link", url: "https://example.com" };
    const video = {
      type: "mdxJsxFlowElement",
      name: "video",
      attributes: [{ type: "mdxJsxAttribute", name: "src", value: "./video.mp4" }],
    };
    const board = {
      type: "mdxJsxFlowElement",
      name: "Whiteboard",
      attributes: [{ type: "mdxJsxAttribute", name: "id", value: "board" }],
    };
    const read = vi.fn(async (url: string) => `data:${url}`);
    await inlineScratchpadAssets(
      {
        children: [
          image,
          definition,
          { type: "imageReference", identifier: "diagram" },
          link,
          video,
          board,
        ],
      },
      read,
      "wt",
    );
    expect(image.url).toBe("data:./image.png");
    expect(definition.url).toBe("data:./diagram.svg");
    expect(video.attributes[0]?.value).toBe("data:./video.mp4");
    expect(board.name).toBe("img");
    expect(board.attributes).toContainEqual({
      type: "mdxJsxAttribute",
      name: "src",
      value: "data:image/png;base64,cG5n",
    });
    expect(link.url).toBe("https://example.com");
  });

  it("fails the export if a referenced resource cannot be embedded", async () => {
    await expect(
      inlineScratchpadAssets(
        { type: "image", url: "missing.png" },
        async () => {
          throw new Error("missing asset");
        },
        "wt",
      ),
    ).rejects.toThrow("missing asset");
  });
});
