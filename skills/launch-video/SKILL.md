---
name: launch-video
description: Use when editing, previewing, validating, or rendering Pragma's Remotion launch film for the README.
---

# Maintain the Pragma Launch Film

Keep the README launch film reproducible from repository-owned source and assets.

## Project Layout

- `launch-video/index.ts` registers the Remotion root.
- `launch-video/Root.tsx` defines the `PragmaLaunch` composition at 1920x1080 and 30 fps.
- `launch-video/PragmaLaunch.tsx` owns the timeline, scene durations, and presentation.
- `remotion.config.ts` uses `apps/www/public` as Remotion's public directory. Resolve clips,
  audio, and agent marks with `staticFile()` from that directory; do not duplicate assets
  under `launch-video`.
- `.github/assets/pragma-launch.mp4` is the rendered README artifact.

Component-bearing `.tsx` files use PascalCase. Keep the composition id `PragmaLaunch`
aligned with the root render command, and derive the total composition duration from the
scene durations so timeline edits cannot leave the registry stale.

## Workflow

Run commands from the repository root:

```bash
bun run video:studio
bun run video:typecheck
bun run video:render
```

Use Studio to review the entire timeline after changing scenes, timing, typography, or
assets. Run the focused typecheck before rendering. The render command writes the tracked
README film to `.github/assets/pragma-launch.mp4` using the codec and quality settings in
`remotion.config.ts`.

The soundtrack is generated deterministically by `launch-video/generate-lofi.ts`. When
changing that generator, run `bun run video:music`; it replaces
`apps/www/public/media/pragma-lofi.wav`. Do not regenerate the soundtrack for unrelated
video edits.

Product recordings live in `apps/www/public/media`. When replacing a recording, verify
its full playback in Studio and update the corresponding scene duration in
`PragmaLaunch.tsx` so it is neither cut short nor followed by a frozen tail. Finish by
running the repository's ordinary format and quality checks for every source file changed.
