import { describe, expect, test } from "bun:test";

import {
  COMMENT_MARKER,
  decide,
  describePlan,
  renderComment,
  type BuildSummary,
} from "./pragma-go-ship-plan";

const FINGERPRINT = "f06262249d711bdfd0090562458987bcbb92686b";

function build(id: string, hash: string, appBuildVersion = "15"): BuildSummary {
  return {
    id,
    appBuildVersion,
    fingerprint: { hash },
    artifacts: { buildUrl: `https://expo.dev/artifacts/${id}.ipa` },
  };
}

describe("decide", () => {
  test("ships an update when a build already carries the fingerprint", () => {
    const match = build("e0db79ae-61ec", FINGERPRINT);
    const plan = decide("ios", "production", FINGERPRINT, [match], match);
    expect(plan.action).toBe("update");
    expect(plan.matchingBuild).toBe(match);
    expect(plan.profile).toBe("production");
  });

  test("builds a new binary when no build has the fingerprint", () => {
    const latest = build("549a6207-51b", "cc3a606e3e453ed0865e324ec8223f99a37e3714", "14");
    const plan = decide("android", "preview", FINGERPRINT, [], latest);
    expect(plan.action).toBe("build");
    expect(plan.matchingBuild).toBeNull();
    expect(plan.profile).toBe("preview");
  });

  test("does not trust a filtered result whose fingerprint differs", () => {
    const stray = build("549a6207-51b", "cc3a606e3e453ed0865e324ec8223f99a37e3714");
    expect(decide("ios", "production", FINGERPRINT, [stray], stray).action).toBe("build");
  });

  test("builds when the profile has never produced a build", () => {
    const plan = decide("ios", "production", FINGERPRINT, [], null);
    expect(plan.action).toBe("build");
    expect(describePlan(plan)).not.toContain("newest");
  });
});

describe("renderComment", () => {
  test("starts with the sticky marker and describes every platform", () => {
    const match = build("e0db79ae-61ec", FINGERPRINT);
    const latest = build("53e8bae7-391a", "dae1b54ec7e7cbabb7c71d7bbc169140aae3fbd7", "9");
    const body = renderComment([
      decide("ios", "production", FINGERPRINT, [match], match),
      decide("android", "preview", "5c77a381c6b90879", [], latest),
    ]);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("**iOS** → over-the-air update on `production`");
    expect(body).toContain("**Android** → **new binary**");
    expect(body).toContain("eas fingerprint:compare --build-id 53e8bae7-391a");
  });

  test("omits the compare hint when nothing needs a new binary", () => {
    const match = build("e0db79ae-61ec", FINGERPRINT);
    const body = renderComment([decide("ios", "production", FINGERPRINT, [match], match)]);
    expect(body).not.toContain("fingerprint:compare");
  });
});
