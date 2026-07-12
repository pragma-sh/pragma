import { constants, type PairingPayload } from "@pragma/constants";

// Pure, RN-free pairing helpers. The QR code a desktop shows encodes a
// PairingPayload as JSON; the pair screen scans it, validates it here, and (on
// success) persists a ConnectionConfig. Network reachability/token checks live
// in the pair screen because they need the SDK client; everything shape- and
// version-related is pure and unit tested.

/** Protocol version this mobile build speaks; a host must match to pair. */
export const EXPECTED_PROTOCOL_VERSION = constants.daemon.protocolVersion;

/** Persisted connection config the whole app talks to a host through. */
export interface ConnectionConfig {
  url: string;
  token: string;
}

/** Outcome of validating a scanned/entered pairing payload. */
export type PairingValidation =
  | { ok: true; config: ConnectionConfig }
  | { ok: false; reason: string };

/** Parses a scanned QR string into a PairingPayload, or null if malformed. */
export function parsePairingPayload(raw: string): PairingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPairingPayload(parsed)) {
    return null;
  }
  return parsed;
}

/** True when the host's protocol version matches this build's. */
function isProtocolCompatible(version: number): boolean {
  return version === EXPECTED_PROTOCOL_VERSION;
}

/**
 * Validates a scanned payload's shape and protocol version, returning a
 * ready-to-persist {@link ConnectionConfig} on success. Reachability and token
 * validity are checked separately (they require a live request).
 */
export function validatePairingPayload(payload: PairingPayload): PairingValidation {
  if (!isProtocolCompatible(payload.protocolVersion)) {
    return {
      ok: false,
      reason: `Host speaks protocol v${payload.protocolVersion}; this app expects v${EXPECTED_PROTOCOL_VERSION}. Update both to the same version.`,
    };
  }
  return validateManualEntry(payload.url, payload.token);
}

/**
 * Validates hand-typed URL + token fallback fields. The protocol version is
 * unknown for manual entry, so only shape is checked here; the live
 * `agents.catalog()` probe in the pair screen confirms reachability + token.
 */
export function validateManualEntry(url: string, token: string): PairingValidation {
  const trimmedUrl = url.trim();
  const trimmedToken = token.trim();
  if (!isHttpUrl(trimmedUrl)) {
    return { ok: false, reason: "Enter a valid https:// gateway URL." };
  }
  if (!trimmedToken) {
    return { ok: false, reason: "Enter the gateway token from the desktop." };
  }
  return { ok: true, config: { url: stripTrailingSlash(trimmedUrl), token: trimmedToken } };
}

function isPairingPayload(value: unknown): value is PairingPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === "string" &&
    typeof record.token === "string" &&
    typeof record.protocolVersion === "number" &&
    typeof record.hostName === "string"
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/.+/i.test(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
