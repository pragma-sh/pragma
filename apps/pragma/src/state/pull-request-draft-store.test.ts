import { afterEach, describe, expect, it } from "vitest";

import {
  clearPullRequestDraft,
  readPullRequestDraft,
  savePullRequestDraft,
  storeGeneratedPullRequestDraft,
} from "@/state/pull-request-draft-store";

afterEach(() => localStorage.clear());

describe("pull-request-draft-store", () => {
  it("keeps a hand-written form undrafted", () => {
    savePullRequestDraft("wt", { title: "Fix bug", body: "" });
    expect(readPullRequestDraft("wt")).toEqual({ title: "Fix bug", body: "", drafted: false });
  });

  it("keeps the drafted mark through edits, and drops it when the form is emptied", () => {
    storeGeneratedPullRequestDraft("wt", { title: "Add refresh", body: "Adds it." });
    savePullRequestDraft("wt", { title: "Add token refresh", body: "Adds it." });
    expect(readPullRequestDraft("wt").drafted).toBe(true);

    savePullRequestDraft("wt", { title: "", body: "" });
    expect(readPullRequestDraft("wt").drafted).toBe(false);
  });

  it("clears the form once the PR is opened", () => {
    storeGeneratedPullRequestDraft("wt", { title: "Add refresh", body: "" });
    clearPullRequestDraft("wt");
    expect(readPullRequestDraft("wt")).toEqual({ title: "", body: "", drafted: false });
  });
});
