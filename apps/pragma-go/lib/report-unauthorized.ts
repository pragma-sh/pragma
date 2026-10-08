import { PragmaGatewayError } from "@pragma-sh/sdk";

/** Hands a 401 to the connection, which clears the pairing; ignores anything else. */
export function reportUnauthorized(error: unknown, onUnauthorized: () => void): void {
  if (error instanceof PragmaGatewayError && error.httpStatus === 401) onUnauthorized();
}
