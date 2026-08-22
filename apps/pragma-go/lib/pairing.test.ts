import type { PairingPayload } from "@pragma/constants";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_PROTOCOL_VERSION,
  parsePairingPayload,
  validateManualEntry,
  validatePairingPayload,
} from "./pairing";

function payload(over: Partial<PairingPayload> = {}): PairingPayload {
  return {
    url: "https://abc.ngrok.app",
    token: "secret-token",
    protocolVersion: EXPECTED_PROTOCOL_VERSION,
    hostName: "Ethan's MacBook",
    ...over,
  };
}

describe("parsePairingPayload", () => {
  it("parses a well-formed JSON payload", () => {
    const parsed = parsePairingPayload(JSON.stringify(payload()));
    expect(parsed).toMatchObject({ url: "https://abc.ngrok.app", hostName: "Ethan's MacBook" });
  });

  it("returns null for non-JSON", () => {
    expect(parsePairingPayload("not json")).toBeNull();
  });

  it("returns null when a field is missing or mistyped", () => {
    expect(parsePairingPayload(JSON.stringify({ url: "https://x", token: "t" }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ ...payload(), protocolVersion: 15 }))).toBeNull();
  });
});

describe("validatePairingPayload", () => {
  it("accepts a matching protocol version and strips a trailing slash", () => {
    const result = validatePairingPayload(payload({ url: "https://abc.ngrok.app/" }));
    expect(result).toEqual({
      ok: true,
      config: { url: "https://abc.ngrok.app", token: "secret-token" },
    });
  });

  it("rejects a mismatched protocol version", () => {
    const result = validatePairingPayload(
      payload({ protocolVersion: `${EXPECTED_PROTOCOL_VERSION}-other` }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateManualEntry", () => {
  it("accepts a valid url + token", () => {
    expect(validateManualEntry("https://host.dev ", " tok ")).toEqual({
      ok: true,
      config: { url: "https://host.dev", token: "tok" },
    });
  });

  it("rejects a non-http url", () => {
    expect(validateManualEntry("host.dev", "tok").ok).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(validateManualEntry("https://host.dev", "  ").ok).toBe(false);
  });
});
