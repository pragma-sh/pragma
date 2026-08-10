import { beforeEach, describe, expect, it, vi } from "vitest";

import { constants } from "@pragma/constants";

import {
  appendPrSignature,
  buildPrSignature,
  resetPrSignatureCache,
  stripPrSignature,
  validateGitHubSettings,
} from "@/lib/pr-signature";
import { readConfig } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({ readConfig: vi.fn() }));

const readConfigMock = vi.mocked(readConfig);
const { prSignature } = constants.github;

/** Stubs the global `.pragma/config.json` the setting is read from. */
function configContents(contents: string): void {
  readConfigMock.mockResolvedValue({ contents } as Awaited<ReturnType<typeof readConfig>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrSignatureCache();
  configContents("{}");
});

describe("buildPrSignature", () => {
  it("links the heading to Pragma's home page and the badge to the worktree deep link", () => {
    const signature = buildPrSignature("wt-1");
    expect(signature).toContain(`](${constants.github.homepageUrl})`);
    expect(signature).toContain(`![${prSignature.badgeAlt}](${prSignature.badgeUrl})`);
    expect(signature).toContain(`](${prSignature.openUrl}?worktree=wt-1)`);
    expect(signature.startsWith(prSignature.startMarker)).toBe(true);
    expect(signature.endsWith(prSignature.endMarker)).toBe(true);
  });

  it("escapes a worktree id so it cannot break out of the query string", () => {
    expect(buildPrSignature("a b&c")).toContain(`?worktree=a%20b%26c)`);
  });

  it("links to the plain redirector when there is no worktree", () => {
    expect(buildPrSignature(null)).toContain(`](${prSignature.openUrl})`);
  });

  it("opens with a rule so the footer reads as separate from the author's description", async () => {
    const body = await appendPrSignature("Fixes the thing.", "wt-1");
    expect(body).toContain(`Fixes the thing.\n\n${prSignature.startMarker}\n\n---\n`);
  });

  it("puts the tagline under the heading rather than in it", () => {
    const signature = buildPrSignature("wt-1");
    expect(signature).toContain(`### [Created with Pragma](${constants.github.homepageUrl})`);
    expect(signature).toContain("<sub>A terminal agentic development environment</sub>");
  });

  it("names where the footer is turned off", () => {
    expect(buildPrSignature("wt-1")).toContain("Settings → GitHub");
  });

  // The href has to survive GitHub's markdown sanitizer, which keeps only
  // http/https/mailto — a raw `pragma://` link would render as inert text.
  it("uses an https href, never the deep-link scheme", () => {
    expect(buildPrSignature("wt-1")).not.toContain("pragma://");
  });
});

describe("stripPrSignature", () => {
  it("removes the footer and the blank lines it was joined with", async () => {
    const body = await appendPrSignature("Fixes the thing.", "wt-1");
    expect(stripPrSignature(body)).toBe("Fixes the thing.");
  });

  it("leaves a body that has no footer alone", () => {
    expect(stripPrSignature("Just a description.")).toBe("Just a description.");
  });

  it("removes every footer when a body somehow carries more than one", () => {
    const body = `A\n\n${buildPrSignature("wt-1")}\n\nB\n\n${buildPrSignature("wt-2")}`;
    expect(stripPrSignature(body)).toBe("A\n\n\n\nB");
  });

  // GitHub truncates bodies at 65 536 characters, which can cut the end marker off.
  it("cuts an unterminated footer to the end of the body", () => {
    const body = `A\n\n${prSignature.startMarker}\n\n### Created with Pragma`;
    expect(stripPrSignature(body)).toBe("A");
  });
});

describe("appendPrSignature", () => {
  it("appends the footer when the setting is unset", async () => {
    const body = await appendPrSignature("Body.", "wt-1");
    expect(body).toContain(prSignature.startMarker);
    expect(body.startsWith("Body.\n\n")).toBe(true);
  });

  it("does not stack footers when a draft is regenerated", async () => {
    const once = await appendPrSignature("Body.", "wt-1");
    const twice = await appendPrSignature(once, "wt-1");
    expect(twice.split(prSignature.startMarker)).toHaveLength(2);
  });

  it("returns a footer-free body when the user turned it off", async () => {
    configContents(JSON.stringify({ github: { prSignature: false } }));
    const body = await appendPrSignature("Body.", "wt-1");
    expect(body).toBe("Body.");
  });

  it("appends to an empty body without leading blank lines", async () => {
    const body = await appendPrSignature("", "wt-1");
    expect(body.startsWith(prSignature.startMarker)).toBe(true);
  });

  it("falls back to the shipped default when the config cannot be read", async () => {
    readConfigMock.mockRejectedValue(new Error("no config"));
    const body = await appendPrSignature("Body.", "wt-1");
    expect(body.includes(prSignature.startMarker)).toBe(prSignature.enabled);
  });

  it("reads the config once and reuses the answer until it is invalidated", async () => {
    await appendPrSignature("Body.", "wt-1");
    await appendPrSignature("Body.", "wt-1");
    expect(readConfigMock).toHaveBeenCalledTimes(1);
    resetPrSignatureCache();
    await appendPrSignature("Body.", "wt-1");
    expect(readConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("validateGitHubSettings", () => {
  it("accepts an absent or empty block", () => {
    expect(validateGitHubSettings(undefined)).toEqual({});
    expect(validateGitHubSettings({})).toEqual({});
  });

  it("rejects a non-object block", () => {
    expect(() => validateGitHubSettings([])).toThrow("github must be an object");
  });

  it("rejects a non-boolean prSignature", () => {
    expect(() => validateGitHubSettings({ prSignature: "yes" })).toThrow(
      "github.prSignature must be a boolean",
    );
  });
});
