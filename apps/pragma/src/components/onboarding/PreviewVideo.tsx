import { useState } from "react";

import { constants } from "@pragma/constants";

import { cn } from "@/lib/utils";

/**
 * A looping product clip from the marketing site, shown in the media panel of
 * an onboarding step. It is letterboxed rather than cropped — the clips are
 * product recordings whose edges carry meaning, so the panel's `bg-muted`
 * shows through instead of the frame being trimmed to fill it.
 *
 * The clips are streamed from `onboarding.mediaBaseUrl` rather than bundled:
 * they are tens of megabytes that only ever play once, on a machine that has
 * just been used to sign in. Offline (or with the site unreachable) the element
 * errors and is replaced by a neutral placeholder, so the step still reads.
 */
export function PreviewVideo({
  className,
  file,
  label,
}: {
  className?: string;
  /** File name under the media base URL, e.g. `github.mp4`. */
  file: string;
  /** Accessible description of what the clip shows. */
  label: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={cn(
          "bg-muted text-muted-foreground flex size-full items-center justify-center text-xs",
          className,
        )}
      >
        Preview unavailable offline
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- decorative product loop: muted, no speech, described by `aria-label`
    <video
      aria-label={label}
      autoPlay
      className={cn("size-full object-contain", className)}
      loop
      muted
      onError={() => setFailed(true)}
      playsInline
      src={`${constants.onboarding.mediaBaseUrl}/${file}`}
    />
  );
}
