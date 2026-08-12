import { PRAGMA_ENV_KEYS, readEnv } from "./env";
import { PragmaGatewayError, PragmaTransportError } from "./errors";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PragmaClientConfig {
  baseUrl?: string;
  token?: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class Transport {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly headers: Record<string, string>;

  constructor(config: PragmaClientConfig = {}) {
    const { baseUrl, token } = requireGatewayConfig(config);
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetch = requireFetch(config.fetch);
    this.headers = config.headers ?? {};
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(path, options);
    if (response.status === 204 || response.status === 202) {
      return undefined as T;
    }
    return parseJson<T>(response);
  }

  async raw(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.headers,
      ...options.headers,
      authorization: `Bearer ${this.token}`,
    };
    let body: BodyInit | undefined;
    if (options.rawBody) {
      body = options.rawBody as unknown as BodyInit;
    } else if (options.body !== undefined) {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetch(urlFor(this.baseUrl, path), {
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      throw new PragmaTransportError("failed to reach Pragma gateway", error);
    }
    if (!response.ok) {
      throw await gatewayError(response);
    }
    return response;
  }
}

function requireGatewayConfig(config: PragmaClientConfig): { baseUrl: string; token: string } {
  const baseUrl = stripTrailingSlash(config.baseUrl ?? readEnv(PRAGMA_ENV_KEYS.gatewayUrl) ?? "");
  const token = config.token ?? readEnv(PRAGMA_ENV_KEYS.gatewayToken) ?? "";
  if (!baseUrl || !token) {
    throw new PragmaTransportError("Pragma gateway baseUrl and token are required");
  }
  return { baseUrl, token };
}

function requireFetch(fetch: FetchLike | undefined): FetchLike {
  const resolved = fetch ?? globalThis.fetch?.bind(globalThis);
  if (!resolved) {
    throw new PragmaTransportError("global fetch is not available");
  }
  return resolved;
}

export function urlFor(baseUrl: string, path: string): string {
  return `${stripTrailingSlash(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new PragmaTransportError("gateway returned non-JSON response", error);
  }
}

async function gatewayError(response: Response): Promise<PragmaGatewayError> {
  let body: { code?: string; message?: string; details?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new PragmaTransportError("gateway returned non-JSON error response", error);
  }
  return new PragmaGatewayError(body.message ?? `gateway returned ${response.status}`, {
    code: body.code ?? "internal",
    httpStatus: response.status,
    details: body.details,
  });
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
