import { bytesToBase64 } from "./encoding";
import { routes } from "./routes";
import type { Transport } from "./transport";

/** A fetched asset: its raw bytes and MIME type. */
export interface FetchedAsset {
  bytes: Uint8Array;
  mime: string;
}

/**
 * Gateway namespace for plugin-contributed assets (agent icons). Assets are
 * fetched by content hash through the authenticated SDK transport — never as
 * bare `<img>` URLs — so the bearer token rides the request header.
 */
export class AssetsClient {
  constructor(private readonly transport: Transport) {}

  /** Fetches an asset's raw bytes + MIME type by content hash. */
  async fetch(hash: string, options: { signal?: AbortSignal } = {}): Promise<FetchedAsset> {
    const response = await this.transport.raw(routes.asset(hash), { signal: options.signal });
    const mime = response.headers.get("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mime };
  }

  /** Fetches an asset and returns it as a `data:` URI, ready for an `<img src>`. */
  async toDataUri(hash: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const { bytes, mime } = await this.fetch(hash, options);
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }
}
