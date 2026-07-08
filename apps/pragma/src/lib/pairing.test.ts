import { describe, expect, it } from "vitest";

import {
  buildPairingPayload,
  encodePairingPayload,
  parsePairingPayload,
  validatePairingPayload,
} from "./pairing";

const VALID = {
  url: "https://abc.ngrok-free.app",
  token: "secret-token",
  protocolVersion: 13,
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
    expect(validatePairingPayload({ ...VALID, protocolVersion: "13" })).toBeNull();
  });

  it("rejects non-object values", () => {
    expect(validatePairingPayload(null)).toBeNull();
    expect(validatePairingPayload(42)).toBeNull();
  });
});
