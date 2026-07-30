import type { FileChange, FileChunk, Tab } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileChunkMock = vi.fn();
vi.mock("@/lib/tauri", () => ({
  readFileChunk: (...args: unknown[]) => readFileChunkMock(...args),
}));
vi.mock("@/lib/file-watch", () => ({
  useWorktreeFileChange: (_worktreeId: string, _onChange: (change: FileChange) => void) => {},
}));

const { MediaView } = await import("@/components/media/MediaView");

/**
 * A tab on its own file. Binary bytes are cached per worktree+path across
 * mounts, so tests must not share a path unless they are exercising that cache.
 */
function tabFor(name: string, ext: string): Tab {
  return { id: `tab-${name}`, worktreeId: "wt-1", filePath: `media/${name}.${ext}` } as Tab;
}

/** One complete chunk holding `bytes`. */
function wholeFile(bytes: number[]): FileChunk {
  return {
    base64: btoa(String.fromCharCode(...bytes)),
    offset: 0,
    byteSize: bytes.length,
    eof: true,
  };
}

describe("MediaView", () => {
  beforeEach(() => {
    readFileChunkMock.mockReset();
  });
  afterEach(cleanup);

  it("renders an image once the bytes have loaded", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([137, 80, 78, 71]));

    render(<MediaView tab={tabFor("hero", "png")} />);

    const image = await screen.findByRole("img", { name: "hero.png" });
    expect(image).toHaveAttribute("src", expect.stringMatching(/^blob:/));
  });

  it("renders a video element for video files", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([0, 0, 0, 1]));

    render(<MediaView tab={tabFor("clip", "mp4")} />);

    const video = await screen.findByLabelText("clip.mp4");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("src", expect.stringMatching(/^blob:/));
  });

  it("renders audio with themed transport controls", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([1, 2, 3]));

    render(<MediaView tab={tabFor("track", "mp3")} />);

    const player = await screen.findByLabelText("track.mp3");
    expect(player.tagName).toBe("AUDIO");
    expect(player).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
  });

  it("surfaces an image the browser cannot decode, with a retry that reads again", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([137, 80]));

    render(<MediaView tab={tabFor("corrupt", "png")} />);

    fireEvent.error(await screen.findByRole("img", { name: "corrupt.png" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be displayed/);
    readFileChunkMock.mockClear();
    screen.getByRole("button", { name: "Retry" }).click();

    await waitFor(() => expect(readFileChunkMock).toHaveBeenCalled());
  });

  it("names the decode failure reported by a video element", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([0, 0, 0, 1]));

    render(<MediaView tab={tabFor("broken", "mp4")} />);
    const video = await screen.findByLabelText("broken.mp4");
    // jsdom never populates `error`; stand in for a browser decode failure.
    Object.defineProperty(video, "error", { value: { code: 4 }, configurable: true });

    fireEvent.error(video);

    expect(await screen.findByRole("alert")).toHaveTextContent(/codec is not supported/);
  });

  it("surfaces a rejected play() on the audio transport", async () => {
    readFileChunkMock.mockResolvedValue(wholeFile([1, 2, 3]));
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValue(new Error("decode failed"));

    render(<MediaView tab={tabFor("unplayable", "mp3")} />);
    (await screen.findByRole("button", { name: "Play" })).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(/decode failed/);
    play.mockRestore();
  });

  it("surfaces a read failure with a retry that reads again", async () => {
    readFileChunkMock.mockRejectedValueOnce(new Error("permission denied"));

    render(<MediaView tab={tabFor("retried", "png")} />);

    expect(await screen.findByText("permission denied")).toBeInTheDocument();
    readFileChunkMock.mockResolvedValue(wholeFile([137]));
    screen.getByRole("button", { name: "Retry" }).click();

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "retried.png" })).toBeInTheDocument(),
    );
  });
});
