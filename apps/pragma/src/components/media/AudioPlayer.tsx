/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-static-element-interactions, jsx-a11y/media-has-caption -- the player surface must take focus for play/seek shortcuts; the hidden <audio> has no caption track because local project clips are played as-is. */
import { Icon } from "@iconify/react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Slider } from "radix-ui";

import { useAudioPlayer } from "@/components/media/use-audio-player";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Formats a media clock as `m:ss` (or `h:mm:ss` past an hour). */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const padded = secs.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${padded}`;
  }
  return `${minutes}:${padded}`;
}

/**
 * Themed audio surface: filename toolbar, centered artwork, and Pragma-styled
 * transport (play/pause, seek, mute/volume) driven by a hidden `<audio>`.
 */
export function AudioPlayer({ url, name }: { url: string; name: string }) {
  const audio = useAudioPlayer();

  return (
    <div
      className="flex h-full flex-col bg-canvas outline-none"
      onKeyDown={audio.onKeyDown}
      tabIndex={0}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-background px-2">
        <p className="truncate text-xs text-muted-foreground">{name}</p>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col gap-6">
          <AudioArtwork name={name} />
          <AudioTransport audio={audio} />
        </div>
      </div>

      <audio
        aria-label={name}
        className="hidden"
        preload="metadata"
        ref={audio.audioRef}
        src={url}
      />
    </div>
  );
}

function AudioArtwork({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex size-24 items-center justify-center rounded-2xl border border-border bg-muted/40">
        <Icon aria-hidden className="size-12" icon="vscode-icons:file-type-audio" />
      </div>
      <div className="min-w-0 max-w-full">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">Audio</p>
      </div>
    </div>
  );
}

function AudioTransport({ audio }: { audio: ReturnType<typeof useAudioPlayer> }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <Button
          aria-label={audio.playing ? "Pause" : "Play"}
          onClick={audio.togglePlay}
          size="icon"
          title={audio.playing ? "Pause" : "Play"}
          type="button"
          variant="default"
        >
          {audio.playing ? <Pause /> : <Play />}
        </Button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <AudioSlider
            ariaLabel="Seek"
            max={audio.seekMax}
            onCommit={audio.commitSeek}
            onPreview={audio.beginSeekPreview}
            step={0.1}
            value={audio.currentTime}
          />
          <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{formatMediaTime(audio.currentTime)}</span>
            <span>{formatMediaTime(audio.duration)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pl-1">
        <Button
          aria-label={audio.muted ? "Unmute" : "Mute"}
          onClick={audio.toggleMute}
          size="icon-sm"
          title={audio.muted ? "Unmute" : "Mute"}
          type="button"
          variant="ghost"
        >
          {audio.muted ? <VolumeX /> : <Volume2 />}
        </Button>
        <AudioSlider
          ariaLabel="Volume"
          className="max-w-28"
          max={1}
          onCommit={audio.setVolumeLevel}
          onPreview={audio.setVolumeLevel}
          step={0.01}
          value={audio.muted ? 0 : audio.volume}
        />
      </div>
    </div>
  );
}

/** Thin themed range control shared by seek and volume. */
function AudioSlider({
  value,
  max,
  step,
  ariaLabel,
  className,
  onPreview,
  onCommit,
}: {
  value: number;
  max: number;
  step: number;
  ariaLabel: string;
  className?: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const safeMax = max > 0 ? max : 1;
  const safeValue = Math.min(Math.max(0, value), safeMax);

  return (
    <Slider.Root
      className={cn(
        "relative flex h-4 w-full touch-none select-none items-center",
        max <= 0 && "opacity-50",
        className,
      )}
      disabled={max <= 0 && ariaLabel === "Seek"}
      max={safeMax}
      onValueChange={([next]) => onPreview(next ?? 0)}
      onValueCommit={([next]) => onCommit(next ?? 0)}
      step={step}
      value={[safeValue]}
    >
      <Slider.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
        <Slider.Range className="absolute h-full rounded-full bg-primary" />
      </Slider.Track>
      <Slider.Thumb
        aria-label={ariaLabel}
        className="block size-3.5 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      />
    </Slider.Root>
  );
}
