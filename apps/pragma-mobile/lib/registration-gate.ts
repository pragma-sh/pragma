// Pure, RN-free ordering for the one push registration that may be in flight.
// Unpair revokes the device's token, but a `POST /v1/push/tokens` still on the
// wire would land after that `DELETE` and re-arm delivery to a phone that just
// unpaired. The gate lets the revoking side wait for (or cancel) the
// registration first, and lets a screen cancel its own registration on unmount.

/** Serialises push registration against the revocation that must follow it. */
export interface RegistrationGate {
  /**
   * Runs `task` as the current registration. The signal it receives aborts when
   * `external` aborts, or when {@link RegistrationGate.settle} runs out of
   * patience.
   */
  run: <T>(task: (signal: AbortSignal) => Promise<T>, external?: AbortSignal) => Promise<T>;
  /**
   * Resolves once no registration is in flight, so the caller's request is
   * ordered after it. A registration still running after `graceMs` is aborted
   * rather than waited on forever.
   */
  settle: (graceMs: number) => Promise<void>;
}

interface RunningRegistration {
  controller: AbortController;
  /** Settles (never rejects) when the registration is done. */
  done: Promise<void>;
}

/** Creates an independent gate; the app shares the one in `push.ts`. */
export function createRegistrationGate(): RegistrationGate {
  let running: RunningRegistration | null = null;

  async function run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const detach = forwardAbort(external, controller);
    const result = task(controller.signal);
    const entry: RunningRegistration = { controller, done: result.then(ignore, ignore) };
    running = entry;
    try {
      return await result;
    } finally {
      if (running === entry) running = null;
      detach();
    }
  }

  async function settle(graceMs: number): Promise<void> {
    const entry = running;
    if (!entry) return;
    const timer = setTimeout(() => entry.controller.abort(), graceMs);
    try {
      await entry.done;
    } finally {
      clearTimeout(timer);
    }
  }

  return { run, settle };
}

/** Mirrors an external abort onto the gate's controller, returning a detacher. */
function forwardAbort(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return ignore;
  if (external.aborted) {
    controller.abort();
    return ignore;
  }
  const abort = () => controller.abort();
  external.addEventListener("abort", abort);
  return () => external.removeEventListener("abort", abort);
}

function ignore(): void {
  // Deliberately empty: the gate only cares that the registration finished.
}
