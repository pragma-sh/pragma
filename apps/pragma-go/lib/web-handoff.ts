import type { ConnectionConfig } from "./pairing";

/**
 * Native builds have no page URL to inherit a connection from — they pair by QR
 * or by hand. The web build swaps in `web-handoff.web.ts`.
 */
export function takeTokenFromUrl(): ConnectionConfig | null {
  return null;
}

/** Pre-filled gateway URL for the pair screen; native has nothing to suggest. */
export function defaultGatewayUrl(): string {
  return "";
}
