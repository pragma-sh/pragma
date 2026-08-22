import { describe, expect, it, vi } from "vitest";

import {
  consumePendingNewSession,
  NEW_SESSION_EVENT,
  type NewSessionDeepLinkDetail,
  parseNewSessionDeepLink,
  parsePluginInstallDeepLink,
  requestNewSession,
} from "@/lib/deep-link";

/** Base64-encodes a UTF-8 string the same way a deep-link producer would. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("parseNewSessionDeepLink", () => {
  it("parses all query params, decoding the base64 message", () => {
    const message = "Fix the bug 🐛 in src/main.rs";
    const url = `pragma://open?agent=claude&worktree=wt-1&message=${encodeURIComponent(
      encode(message),
    )}&autoSubmit=1`;
    expect(parseNewSessionDeepLink(url)).toEqual({
      agentId: "claude",
      modelId: null,
      reasoningId: null,
      worktreeId: "wt-1",
      message,
      autoSubmit: true,
    });
  });

  it("uses the last non-empty duplicate query param", () => {
    const url = "pragma://open?worktree=agent-control&agent=claude&agent=opencode&worktree=wt-2";
    expect(parseNewSessionDeepLink(url)).toMatchObject({
      agentId: "opencode",
      modelId: null,
      reasoningId: null,
      worktreeId: "wt-2",
    });
  });

  it("parses explicit model and reasoning params", () => {
    expect(
      parseNewSessionDeepLink("pragma://open?agent=claude-code&model=sonnet&reasoning=low"),
    ).toMatchObject({
      agentId: "claude-code",
      modelId: "sonnet",
      reasoningId: "low",
    });
  });

  it("ignores explicit model without agent and reasoning without model", () => {
    expect(parseNewSessionDeepLink("pragma://open?model=sonnet&reasoning=low")).toMatchObject({
      agentId: null,
      modelId: null,
      reasoningId: null,
    });
    expect(parseNewSessionDeepLink("pragma://open?agent=claude-code&reasoning=low")).toMatchObject({
      agentId: "claude-code",
      modelId: null,
      reasoningId: null,
    });
  });

  it("decodes standard base64 messages that contain unescaped plus signs", () => {
    const url = `pragma://open?message=${encode("~~~")}&autoSubmit=1`;
    expect(parseNewSessionDeepLink(url)).toMatchObject({
      message: "~~~",
      autoSubmit: true,
    });
  });

  it("defaults to nulls and no auto-submit when params are absent", () => {
    expect(parseNewSessionDeepLink("pragma://open")).toEqual({
      agentId: null,
      modelId: null,
      reasoningId: null,
      worktreeId: null,
      message: null,
      autoSubmit: false,
    });
  });

  it("decodes URL-safe base64 messages", () => {
    // "<<???>>" base64-encodes to "PDw/Pz8+Pg==", whose URL-safe form swaps +/ → -_.
    const standard = encode("<<???>>");
    const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_");
    const url = `pragma://open?message=${encodeURIComponent(urlSafe)}`;
    expect(parseNewSessionDeepLink(url)?.message).toBe("<<???>>");
  });

  it.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["", false],
  ])("treats autoSubmit=%s as %s", (value, expected) => {
    const url = `pragma://open?autoSubmit=${value}`;
    expect(parseNewSessionDeepLink(url)?.autoSubmit).toBe(expected);
  });

  it("returns null for a different scheme or host", () => {
    expect(parseNewSessionDeepLink("https://open?agent=claude")).toBeNull();
    expect(parseNewSessionDeepLink("pragma://close")).toBeNull();
  });

  it("returns null for a malformed url", () => {
    expect(parseNewSessionDeepLink("not a url")).toBeNull();
  });
});

describe("parsePluginInstallDeepLink", () => {
  it("accepts encoded scoped npm package names", () => {
    expect(
      parsePluginInstallDeepLink("pragma://install-plugin?package=%40pragma-sh%2Fopencode-plugin"),
    ).toEqual({ package: "@pragma-sh/opencode-plugin" });
  });

  it("rejects paths, URLs, and other deep-link hosts", () => {
    expect(parsePluginInstallDeepLink("pragma://install-plugin?package=../plugin")).toBeNull();
    expect(
      parsePluginInstallDeepLink("pragma://install-plugin?package=https%3A%2F%2Fevil.test%2Fp.tgz"),
    ).toBeNull();
    expect(parsePluginInstallDeepLink("pragma://open?package=plugin")).toBeNull();
  });
});

describe("requestNewSession / consumePendingNewSession", () => {
  const detail: NewSessionDeepLinkDetail = {
    agentId: "claude",
    modelId: null,
    reasoningId: null,
    worktreeId: "wt-1",
    message: "hi",
  };

  it("dispatches the event and buffers the request for a late listener", () => {
    const handler = vi.fn();
    window.addEventListener(NEW_SESSION_EVENT, handler);
    requestNewSession(detail);
    window.removeEventListener(NEW_SESSION_EVENT, handler);

    // The live listener sees it…
    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0]![0] as CustomEvent<NewSessionDeepLinkDetail>).detail).toEqual(
      detail,
    );
    // …and a listener mounting afterwards can still drain it once.
    expect(consumePendingNewSession()).toEqual(detail);
    expect(consumePendingNewSession()).toBeNull();
  });
});
