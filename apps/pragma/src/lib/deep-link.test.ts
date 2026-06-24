import { describe, expect, it, vi } from "vitest";

import {
  consumePendingNewChat,
  NEW_CHAT_EVENT,
  type NewChatDeepLinkDetail,
  parseNewChatDeepLink,
  requestNewChat,
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

describe("parseNewChatDeepLink", () => {
  it("parses all query params, decoding the base64 message", () => {
    const message = "Fix the bug 🐛 in src/main.rs";
    const url = `pragma://open?agent=claude&worktree=wt-1&message=${encodeURIComponent(
      encode(message),
    )}&autoSubmit=1`;
    expect(parseNewChatDeepLink(url)).toEqual({
      agentId: "claude",
      worktreeId: "wt-1",
      message,
      autoSubmit: true,
    });
  });

  it("uses the last non-empty duplicate query param", () => {
    const url = "pragma://open?worktree=agent-control&agent=claude&agent=opencode&worktree=wt-2";
    expect(parseNewChatDeepLink(url)).toMatchObject({
      agentId: "opencode",
      worktreeId: "wt-2",
    });
  });

  it("decodes standard base64 messages that contain unescaped plus signs", () => {
    const url = `pragma://open?message=${encode("~~~")}&autoSubmit=1`;
    expect(parseNewChatDeepLink(url)).toMatchObject({
      message: "~~~",
      autoSubmit: true,
    });
  });

  it("defaults to nulls and no auto-submit when params are absent", () => {
    expect(parseNewChatDeepLink("pragma://open")).toEqual({
      agentId: null,
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
    expect(parseNewChatDeepLink(url)?.message).toBe("<<???>>");
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
    expect(parseNewChatDeepLink(url)?.autoSubmit).toBe(expected);
  });

  it("returns null for a different scheme or host", () => {
    expect(parseNewChatDeepLink("https://open?agent=claude")).toBeNull();
    expect(parseNewChatDeepLink("pragma://close")).toBeNull();
  });

  it("returns null for a malformed url", () => {
    expect(parseNewChatDeepLink("not a url")).toBeNull();
  });
});

describe("requestNewChat / consumePendingNewChat", () => {
  const detail: NewChatDeepLinkDetail = { agentId: "claude", worktreeId: "wt-1", message: "hi" };

  it("dispatches the event and buffers the request for a late listener", () => {
    const handler = vi.fn();
    window.addEventListener(NEW_CHAT_EVENT, handler);
    requestNewChat(detail);
    window.removeEventListener(NEW_CHAT_EVENT, handler);

    // The live listener sees it…
    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0]![0] as CustomEvent<NewChatDeepLinkDetail>).detail).toEqual(
      detail,
    );
    // …and a listener mounting afterwards can still drain it once.
    expect(consumePendingNewChat()).toEqual(detail);
    expect(consumePendingNewChat()).toBeNull();
  });
});
