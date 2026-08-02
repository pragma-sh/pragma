import { Button } from "@/components/ui/button";

/**
 * Decode / playback failure notice with a retry that re-reads the file. Shared
 * by the image, video, and audio surfaces so every browser-level media error
 * reads the same way.
 */
export function MediaErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-center text-xs"
      role="alert"
    >
      <p className="text-destructive">{message}</p>
      <Button onClick={onRetry} size="sm" type="button" variant="ghost">
        Retry
      </Button>
    </div>
  );
}
