import type { PairingPayload } from "@pragma/constants";

export type { PairingPayload };

/** Builds a {@link PairingPayload} from the parts shown in the pair modal. */
export function buildPairingPayload(parts: {
  url: string;
  token: string;
  protocolVersion: number;
  hostName: string;
}): PairingPayload {
  return {
    url: parts.url,
    token: parts.token,
    protocolVersion: parts.protocolVersion,
    hostName: parts.hostName,
  };
}

/** Serializes a pairing payload to the compact JSON string encoded in the QR. */
export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses and validates a pairing payload JSON string, returning the typed
 * payload or `null` when any required field is missing or the wrong type.
 */
export function parsePairingPayload(raw: string): PairingPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return validatePairingPayload(value);
}

/** Validates an already-parsed value as a {@link PairingPayload}. */
export function validatePairingPayload(value: unknown): PairingPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { url, token, protocolVersion, hostName } = record;
  if (
    typeof url !== "string" ||
    typeof token !== "string" ||
    typeof protocolVersion !== "number" ||
    typeof hostName !== "string"
  ) {
    return null;
  }
  return { url, token, protocolVersion, hostName };
}
