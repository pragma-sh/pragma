import type { PragmaClientConfig } from "@pragma/sdk";

/**
 * Web counterpart of `gateway-fetch.ts`. Browsers give `fetch` a real
 * `ReadableStream` body, so the SDK's NDJSON reader works against the platform
 * implementation directly — importing `expo/fetch` here would pull the native
 * networking shim into the web bundle for nothing.
 *
 * Bound to `globalThis` because an unbound `fetch` reference throws
 * "Illegal invocation" in some browsers.
 */
export const streamingFetch = globalThis.fetch.bind(globalThis) as unknown as NonNullable<
  PragmaClientConfig["fetch"]
>;
