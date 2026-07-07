import { PragmaGatewayError, type PragmaClient, type SessionEvent } from "@pragma/sdk";

const SESSION_ATTACH_RETRY_MS = 250;
const SESSION_ATTACH_TIMEOUT_MS = 30_000;

/** Streams session events, tolerating watcher start before frontend PTY spawn. */
export async function* attachSessionEvents(
  sdk: PragmaClient,
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<SessionEvent> {
  const deadline = Date.now() + SESSION_ATTACH_TIMEOUT_MS;
  while (!signal.aborted) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry loop needs one live session stream at a time.
      for await (const event of sdk.sessions.attach(sessionId, { signal })) {
        yield event;
      }
      return;
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (!isMissingSession(error) || Date.now() >= deadline) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- backoff before the next attach retry is intentionally serial.
      await delay(SESSION_ATTACH_RETRY_MS, signal);
    }
  }
}

/** Waits until the watched PTY session exits. */
export async function waitForExit(
  sdk: PragmaClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of attachSessionEvents(sdk, sessionId, signal)) {
    if (event.type === "exit") return;
  }
}

function isMissingSession(error: unknown): boolean {
  return (
    error instanceof PragmaGatewayError && (error.code === "notFound" || error.httpStatus === 404)
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    const timer = setTimeout(finish, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish();
      },
      { once: true },
    );
  });
}
