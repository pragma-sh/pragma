import { describe, expect, it } from "vitest";

import { constants } from "./index";
import {
  formatWelcomeHeading,
  pickWelcomeHeading,
  welcomeHeadingText,
  welcomeLocation,
} from "./welcome";

describe("welcomeLocation", () => {
  it("joins project and worktree", () => {
    expect(welcomeLocation("pragma", "welcome-screen")).toBe("pragma/welcome-screen");
  });

  it("drops a missing half", () => {
    expect(welcomeLocation("pragma", null)).toBe("pragma");
    expect(welcomeLocation(null, "welcome-screen")).toBe("welcome-screen");
    expect(welcomeLocation(null, undefined)).toBe("");
  });
});

describe("formatWelcomeHeading", () => {
  it("splits the heading around the location", () => {
    expect(formatWelcomeHeading("Let's build in {location}?", "pragma/main")).toEqual({
      before: "Let's build in ",
      location: "pragma/main",
      after: "?",
    });
  });

  it("returns null without a location", () => {
    expect(formatWelcomeHeading("Let's build in {location}?", "")).toBeNull();
  });

  it("leaves no placeholder in any shipped located variation", () => {
    for (const variation of constants.welcome.located) {
      const parts = formatWelcomeHeading(variation, "p/w");
      expect(parts).not.toBeNull();
      expect(welcomeHeadingText(parts!)).not.toMatch(/\{location\}/);
      expect(parts!.location).toBe("p/w");
    }
  });
});

describe("pickWelcomeHeading", () => {
  it("always returns a shipped variation", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(constants.welcome.located).toContain(pickWelcomeHeading("located"));
      expect(constants.welcome.generic).toContain(pickWelcomeHeading("generic"));
    }
  });

  it("indexes the list with the injected random source", () => {
    expect(pickWelcomeHeading("generic", () => 0)).toBe(constants.welcome.generic[0]);
    expect(pickWelcomeHeading("located", () => 0.999)).toBe(constants.welcome.located.at(-1));
  });
});

describe("shipped copy", () => {
  it("carries the placeholder exactly once in every located heading", () => {
    for (const variation of constants.welcome.located) {
      expect(variation.split(constants.welcome.locationPlaceholder)).toHaveLength(2);
    }
  });

  it("names no location in any generic heading", () => {
    for (const variation of constants.welcome.generic) {
      expect(variation).not.toContain(constants.welcome.locationPlaceholder);
    }
  });

  it("pairs each located heading with a generic one", () => {
    expect(constants.welcome.generic).toHaveLength(constants.welcome.located.length);
  });
});
