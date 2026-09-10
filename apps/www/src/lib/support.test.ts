import { describe, expect, it } from "bun:test";

import { supportProducts, supportTopics, validateSupportRequest } from "./support";

const VALID = {
  name: "Ada",
  email: "ada@example.com",
  product: supportProducts[0].value,
  topic: supportTopics[0].value,
  version: "Pragma 1.4.2 on macOS 26",
  message: "The worktree list stops updating after the second agent finishes.",
};

describe("validateSupportRequest", () => {
  it("resolves the labels the support inbox is emailed", () => {
    const result = validateSupportRequest(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.productLabel).toBe(supportProducts[0].label);
    expect(result.request.topicLabel).toBe(supportTopics[0].label);
  });

  it("keys each message by the input's name so the form can attach it", () => {
    const result = validateSupportRequest({
      name: "",
      email: "not-an-address",
      product: "",
      topic: "",
      version: "",
      message: "too short",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).toSorted()).toEqual([
      "email",
      "message",
      "name",
      "product",
      "topic",
    ]);
  });

  it("rejects a product or topic that is not one we offer", () => {
    expect(validateSupportRequest({ ...VALID, product: "mainframe" }).ok).toBe(false);
    expect(validateSupportRequest({ ...VALID, topic: "billing-dispute" }).ok).toBe(false);
  });

  it("accepts an empty version, since it is optional", () => {
    expect(validateSupportRequest({ ...VALID, version: "" }).ok).toBe(true);
  });

  it("holds messages to the length splitforms will store", () => {
    expect(validateSupportRequest({ ...VALID, message: "x".repeat(4001) }).ok).toBe(false);
    expect(validateSupportRequest({ ...VALID, message: "x".repeat(4000) }).ok).toBe(true);
  });
});
