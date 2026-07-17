import { describe, expect, it } from "vitest";

import { findCredentials } from "./usage-limits-cli";

describe("findCredentials", () => {
  it("reads nested Cursor credentials and normalizes user ids", () => {
    expect(
      findCredentials([
        {
          authInfo: {
            authId: "prefix:user_abc_123:suffix",
            accessToken: " token ",
          },
        },
      ]),
    ).toEqual({ userId: "user_abc_123", accessToken: "token" });
  });

  it("prefers a macOS Keychain token", () => {
    expect(findCredentials([{ userId: "user_1", accessToken: "file" }], "keychain")).toEqual({
      userId: "user_1",
      accessToken: "keychain",
    });
  });

  it("returns null when either credential is missing", () => {
    expect(findCredentials([{ userId: "user_1" }])).toBeNull();
  });
});
