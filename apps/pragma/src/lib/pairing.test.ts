import { describe, expect, it } from "vitest";

import {
  buildPairingPayload,
  buildWebAppUrl,
  encodePairingPayload,
  parsePairingPayload,
  validatePairingPayload,
} from "./pairing";

const VALID = {
  url: "https://abc.ngrok-free.app",
  token: "secret-token",
  protocolVersion: "0.0.0",
  hostName: "Pragma",
};

describe("pairing payload", () => {
  it("builds a payload from its parts", () => {
    expect(buildPairingPayload(VALID)).toEqual(VALID);
  });

  it("round-trips through encode + parse", () => {
    const encoded = encodePairingPayload(buildPairingPayload(VALID));
    expect(parsePairingPayload(encoded)).toEqual(VALID);
  });

  it("rejects non-JSON input", () => {
    expect(parsePairingPayload("not json")).toBeNull();
  });

  it("rejects a payload missing a required field", () => {
    const { token: _token, ...withoutToken } = VALID;
    expect(validatePairingPayload(withoutToken)).toBeNull();
  });

  it("rejects a wrong-typed protocolVersion", () => {
    expect(validatePairingPayload({ ...VALID, protocolVersion: 13 })).toBeNull();
  });

  it("rejects non-object values", () => {
    expect(validatePairingPayload(null)).toBeNull();
    expect(validatePairingPayload(42)).toBeNull();
  });
});

describe("buildWebAppUrl", () => {
  it("puts the token in the fragment so it never reaches the server", () => {
    const link = buildWebAppUrl("https://abc.ngrok-free.app", "secret-token");
    expect(link).toBe("https://abc.ngrok-free.app/web#t=secret-token");
    // Everything before the `#` is what a proxy or access log sees.
    expect(link.split("#")[0]).not.toContain("secret-token");
  });

  it("tolerates a trailing slash on the tunnel URL", () => {
    expect(buildWebAppUrl("https://abc.ngrok-free.app/", "t")).toBe(
      "https://abc.ngrok-free.app/web#t=t",
    );
  });

  it("encodes a token with URL-significant characters", () => {
    expect(buildWebAppUrl("https://h", "a b&c")).toBe("https://h/web#t=a%20b%26c");
  });
});
