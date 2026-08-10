import { describe, expect, it } from "vitest";

import {
  formatWelcomeHeading,
  pickWelcomeHeading,
  welcomeHeadingText,
  welcomeLocation,
  WELCOME_HEADINGS,
} from "@/lib/welcome-headings";

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

  it("leaves no placeholder in any shipped variation", () => {
    for (const variation of WELCOME_HEADINGS) {
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
      expect(WELCOME_HEADINGS).toContain(pickWelcomeHeading());
    }
  });
});
