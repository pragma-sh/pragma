import type { Tab } from "@pragma/constants";

import { MediaDocument } from "@/components/media/MediaDocument";
import { MediaStatus } from "@/components/media/MediaStatus";
import { formatBytes, useMediaFile } from "@/components/media/use-media-file";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { basename } from "@/lib/path";

/**
 * Read-only media surface for `editor` tabs whose file is an image, video, or
 * audio clip — standing in for the CodeMirror editor, which refuses binary
 * content outright. Bytes arrive in chunks (same path as the PDF viewer) and
 * are served to `<img>` / `<video>` / `<audio>` through a blob URL.
 */
export function MediaView({ tab }: { tab: Tab }) {
  const { state, reload } = useMediaFile(tab);
  const name = tab.filePath ? basename(tab.filePath) : "media";

  if (state.kind === "error") {
    return (
      <MediaStatus>
        <p className="text-destructive">{state.message}</p>
        <Button onClick={reload} size="sm" variant="ghost">
          Retry
        </Button>
      </MediaStatus>
    );
  }

  if (state.kind === "loading") {
    const percent =
      state.totalBytes > 0 ? Math.round((state.loadedBytes / state.totalBytes) * 100) : 0;
    return (
      <MediaStatus>
        <p>
          Loading {name}
          {state.totalBytes > 0 ? ` — ${formatBytes(state.totalBytes)}` : ""}…
        </p>
        <Progress className="w-48" value={percent} />
      </MediaStatus>
    );
  }

  return <MediaDocument mediaKind={state.mediaKind} name={name} url={state.url} />;
}
