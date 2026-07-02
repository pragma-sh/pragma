import { PragmaTransportError } from "./errors";

/** Parses an NDJSON response body into JSON values. */
export async function* ndjsonStream<T>(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (!response.body) {
    throw new PragmaTransportError("gateway response is not streamable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const onAbort = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially from one reader.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          yield JSON.parse(line) as T;
        }
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      yield JSON.parse(buffered) as T;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
  }
}
