import type { HostContext } from "./cwd";
import { hostQuote, runOnHost } from "./host-shell";

/**
 * Calls the OpenCode v2 server through `opencode api`, the supported way to
 * reach its background service (it handles the service's address and auth).
 *
 * The request body travels on the command line, so it must never carry a
 * secret: `opencode api` cannot read a body from stdin or a file. Responses may
 * hold secrets (credential values); they stay in the calling sidecar.
 */
export async function openCodeApi(
  ctx: HostContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const data = body === undefined ? "" : ` -d ${hostQuote(JSON.stringify(body))}`;
  const result = await runOnHost(ctx, `opencode api ${method} ${hostQuote(path)}${data}`);
  if (result.status !== 0) {
    const reason = (result.stderr.trim() || result.stdout.trim()).split("\n")[0];
    throw new Error(`OpenCode ${method} ${path} failed${reason ? `: ${reason}` : ""}`);
  }
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenCode ${method} ${path} returned invalid JSON`);
  }
}

/** The `data` member of an OpenCode v2 API response. */
export function responseData(response: unknown): unknown {
  return typeof response === "object" && response !== null && "data" in response
    ? (response as { data: unknown }).data
    : response;
}
