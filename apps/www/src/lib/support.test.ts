import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { submitSupportRequest } from "@/app/(home)/support/actions";

import { supportProducts, supportTopics, validateSupportRequest } from "./support";
import { RATE_LIMIT_MAX, resetRateLimiterForTests } from "./support-rate-limit";

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

const originalFetch = globalThis.fetch;
const originalAccessKey = process.env.SPLIT_FORMS_ACCESS_KEY;

function formDataFor(fields: Partial<typeof VALID> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...fields })) {
    data.set(key, value);
  }
  return data;
}

beforeEach(() => {
  resetRateLimiterForTests();
  process.env.SPLIT_FORMS_ACCESS_KEY = "test-access-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAccessKey === undefined) {
    delete process.env.SPLIT_FORMS_ACCESS_KEY;
  } else {
    process.env.SPLIT_FORMS_ACCESS_KEY = originalAccessKey;
  }
});

describe("submitSupportRequest", () => {
  it("posts the validated payload to splitforms and reports success", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor(),
    );

    expect(state.status).toBe("sent");
    expect(state.message).toContain(VALID.email);
    expect(request?.url).toBe("https://splitforms.com/api/submit");
    expect(request?.method).toBe("POST");
    const body = await request?.json();
    expect(body).toMatchObject({
      access_key: "test-access-key",
      name: VALID.name,
      email: VALID.email,
      product: supportProducts[0].label,
      topic: supportTopics[0].label,
      message: VALID.message,
    });
  });

  it("reports field errors without contacting splitforms", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor({ name: "", email: "" }),
    );

    expect(state.status).toBe("error");
    expect(state.fieldErrors.name).toBeDefined();
    expect(state.fieldErrors.email).toBeDefined();
    expect(called).toBe(false);
  });

  it("answers a filled honeypot as success without contacting splitforms", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const data = formDataFor();
    data.set("botcheck", "I am a bot");
    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      data,
    );

    expect(state.status).toBe("sent");
    expect(called).toBe(false);
  });

  it("reports a misconfiguration when the access key is missing", async () => {
    delete process.env.SPLIT_FORMS_ACCESS_KEY;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor(),
    );

    expect(state.status).toBe("error");
    expect(state.message).toContain("misconfigured");
  });

  it("reports a network failure without losing the typed values", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor(),
    );

    expect(state.status).toBe("error");
    expect(state.message).toContain("could not reach");
    expect(state.values).toEqual(VALID);
  });

  it("reports a non-2xx splitforms response as a send failure", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

    const state = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor(),
    );

    expect(state.status).toBe("error");
    expect(state.message).toContain("could not send that");
  });

  it("rate-limits repeated submissions from the same connection", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true }))) as typeof fetch;

    for (let attempt = 0; attempt < RATE_LIMIT_MAX; attempt++) {
      const state = await submitSupportRequest(
        { status: "idle", message: "", fieldErrors: {}, values: VALID },
        formDataFor(),
      );
      expect(state.status).toBe("sent");
    }

    const limited = await submitSupportRequest(
      { status: "idle", message: "", fieldErrors: {}, values: VALID },
      formDataFor(),
    );
    expect(limited.status).toBe("error");
    expect(limited.message).toContain("Too many requests");
  });
});
