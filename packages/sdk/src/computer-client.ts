import type {
  ComputerActivityEvent,
  ComputerActivitySnapshot,
  ComputerActionResult,
  ComputerApp,
  ComputerWindow,
  ComputerDisplay,
  ComputerSnapshot,
  ComputerPermissions,
  ComputerScreenshot,
  ComputerScreenshotRequest,
  ComputerEndRequest,
  ComputerSession,
  ComputerAppsRequest,
  ComputerWindowsRequest,
  ComputerOpenRequest,
  ComputerFocusRequest,
  ComputerInspectRequest,
  ComputerClickRequest,
  ComputerTypeRequest,
  ComputerKeyRequest,
  ComputerScrollRequest,
  ComputerMoveRequest,
  ComputerDragRequest,
  ComputerPermissionsRequest,
} from "@pragma-sh/constants";
import { base64ToBytes } from "./encoding";
import type { EventsClient } from "./events-client";
import { routes } from "./routes";
import type { Transport } from "./transport";
import { PragmaGatewayError } from "./errors";
import { computerCaller } from "./env";
import type { ComputerFailure } from "@pragma-sh/constants";

/** A host computer-use failure with its stable domain code and recovery hint. */
export class PragmaComputerError extends Error {
  constructor(readonly failure: ComputerFailure) {
    super(failure.message);
    this.name = "PragmaComputerError";
  }
  get code(): ComputerFailure["code"] {
    return this.failure.code;
  }
  get retryable(): boolean {
    return this.failure.retryable;
  }
  get hint(): string | undefined {
    return this.failure.hint;
  }
}
import type {
  ComputerRunRequest,
  ComputerResumeRequest,
  ComputerTask,
  ComputerTaskRequest,
} from "@pragma-sh/constants";

/** Cancellation accepted by every computer-use call. */
export interface ComputerRequestOptions {
  signal?: AbortSignal;
}
/** Screenshot metadata and decoded image bytes. */
export interface ComputerScreenshotBytes extends Omit<ComputerScreenshot, "base64"> {
  data: Uint8Array;
}
/** Snapshot followed by attributed activity deltas. */
export type ComputerSubscriptionEvent =
  | { type: "snapshot"; payload: ComputerActivitySnapshot }
  | { type: "delta"; payload: ComputerActivityEvent };

/** Local-only computer use; the host enforces grants, leases and desktop visibility. */
export class ComputerClient {
  constructor(
    private readonly transport: Transport,
    private readonly events: EventsClient,
  ) {}

  /** Start a durable task. Reuse requestId to retry without duplicating actions. */
  run(request: ComputerRunRequest, options: ComputerRequestOptions = {}): Promise<ComputerTask> {
    return this.rpc("run", request, options);
  }
  /** Read a task even after the caller disconnects or the host restarts. */
  task(request: ComputerTaskRequest, options: ComputerRequestOptions = {}): Promise<ComputerTask> {
    return this.rpc("task", request, options);
  }
  /** Supply literal values and continue a resumable task from a fresh snapshot. */
  resume(
    request: ComputerResumeRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerTask> {
    return this.rpc("resume", request, options);
  }
  /** Cancel the caller's task. Native actions already performed are retained. */
  cancel(
    request: ComputerTaskRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerTask> {
    return this.rpc("cancel", request, options);
  }
  /** Wait until a task completes, fails, or asks the caller for input. */
  async wait(taskId: string, options: ComputerRequestOptions = {}): Promise<ComputerTask> {
    while (true) {
      options.signal?.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polling depends on the previous task state.
      const task = await this.task({ taskId }, options);
      if (task.status !== "running" && task.status !== "needsApproval") return task;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls must wait between serial requests.
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, 250);
        const abort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(options.signal?.reason);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  }

  /** Apps through the host computer-use engine. */
  apps(
    request: ComputerAppsRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerApp[]> {
    return this.rpc("apps", request, options);
  }

  /** Windows through the host computer-use engine. */
  windows(
    request: ComputerWindowsRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerWindow[]> {
    return this.rpc("windows", request, options);
  }

  /** Open through the host computer-use engine. */
  open(
    request: ComputerOpenRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("open", request, options);
  }

  /** Focus through the host computer-use engine. */
  focus(
    request: ComputerFocusRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("focus", request, options);
  }

  /** Inspect through the host computer-use engine. */
  inspect(
    request: ComputerInspectRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerSnapshot> {
    return this.rpc("inspect", request, options);
  }

  /** Click through the host computer-use engine. */
  click(
    request: ComputerClickRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("click", request, options);
  }

  /** Type through the host computer-use engine. */
  type(
    request: ComputerTypeRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("type", request, options);
  }

  /** Key through the host computer-use engine. */
  key(
    request: ComputerKeyRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("key", request, options);
  }

  /** Scroll through the host computer-use engine. */
  scroll(
    request: ComputerScrollRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("scroll", request, options);
  }

  /** Move through the host computer-use engine. */
  move(
    request: ComputerMoveRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("move", request, options);
  }

  /** Drag through the host computer-use engine. */
  drag(
    request: ComputerDragRequest,
    options: ComputerRequestOptions = {},
  ): Promise<ComputerActionResult> {
    return this.rpc("drag", request, options);
  }

  /** Permissions through the host computer-use engine. */
  permissions(
    request: ComputerPermissionsRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerPermissions> {
    return this.rpc("permissions", request, options);
  }

  /** Attached displays in screen coordinates. */
  displays(options: ComputerRequestOptions = {}): Promise<ComputerDisplay[]> {
    return this.rpc("displays", {}, options);
  }
  /** Active sessions, grants awaiting approval, and helper health. */
  status(options: ComputerRequestOptions = {}): Promise<ComputerActivitySnapshot> {
    return this.rpc("status", {}, options);
  }
  /** Release the caller's session and every app lease. Always call when finished. */
  end(
    request: ComputerEndRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<{ ended: boolean; session?: ComputerSession }> {
    return this.rpc("end", request, options);
  }
  /** Capture a window or display and decode the image bytes. */
  async screenshot(
    request: ComputerScreenshotRequest = {},
    options: ComputerRequestOptions = {},
  ): Promise<ComputerScreenshotBytes> {
    const { base64, ...shot } = await this.rpc<ComputerScreenshot>(
      "screenshot",
      { ...request, base64: true },
      options,
    );
    if (!base64) throw new Error("Computer screenshot did not include image bytes");
    return { ...shot, data: base64ToBytes(base64) };
  }
  /** Computer activity requires the same local credential as input. */
  async *activity(options: ComputerRequestOptions = {}): AsyncGenerator<ComputerSubscriptionEvent> {
    for await (const event of this.events.subscribe("computerActivity", options)) {
      if (event.type === "snapshot")
        yield { type: "snapshot", payload: event.payload as ComputerActivitySnapshot };
      else yield { type: "delta", payload: event.payload as ComputerActivityEvent };
    }
  }
  private async rpc<T>(op: string, request: object, options: ComputerRequestOptions): Promise<T> {
    try {
      return await this.transport.request<T>(routes.rpc("computer"), {
        method: "POST",
        body: { ...request, op, caller: computerCaller() },
        signal: options.signal,
        localOnly: true,
      });
    } catch (error) {
      if (
        error instanceof PragmaGatewayError &&
        error.details &&
        typeof error.details === "object" &&
        "code" in error.details &&
        "message" in error.details
      )
        throw new PragmaComputerError(error.details as ComputerFailure);
      throw error;
    }
  }
}
