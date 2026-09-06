import { Composition } from "remotion";

import { PragmaLaunch, PRAGMA_LAUNCH_DURATION_IN_FRAMES } from "./PragmaLaunch";

/** Remotion composition registry for Pragma launch media. */
export function RemotionRoot() {
  return (
    <Composition
      id="PragmaLaunch"
      component={PragmaLaunch}
      durationInFrames={PRAGMA_LAUNCH_DURATION_IN_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  );
}
