/** Error returned by the Pragma HTTP gateway. */
export class PragmaGatewayError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /**
   * Domain error detail the gateway code cannot express — for a fanout, the
   * `FanoutFailure` (its own failure code, the member it belongs to, and the
   * finalize stage it stopped at). Present only when the host sent one.
   */
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    message: string,
    info: { code: string; httpStatus: number; details?: unknown; cause?: unknown },
  ) {
    super(message, { cause: info.cause });
    this.name = "PragmaGatewayError";
    this.code = info.code;
    this.httpStatus = info.httpStatus;
    this.details = info.details;
    this.cause = info.cause;
  }
}

/** Network, configuration, and non-JSON transport failure. */
export class PragmaTransportError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PragmaTransportError";
    this.cause = cause;
  }
}
