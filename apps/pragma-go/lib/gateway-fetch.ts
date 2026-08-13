import type { PragmaClientConfig } from "@pragma/sdk";
import { fetch as expoFetch } from "expo/fetch";

/**
 * Fetch the SDK's NDJSON reader can stream through. React Native's global
 * `fetch` does not expose a real `ReadableStream` body, so native must use
 * Expo's; the web build swaps in `gateway-fetch.web.ts`, where the platform
 * `fetch` already streams.
 */
export const streamingFetch = expoFetch as unknown as NonNullable<PragmaClientConfig["fetch"]>;
