/** Error returned by the Pragma HTTP gateway. */
export class PragmaGatewayError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  override readonly cause?: unknown;

  constructor(message: string, details: { code: string; httpStatus: number; cause?: unknown }) {
    super(message, { cause: details.cause });
    this.name = "PragmaGatewayError";
    this.code = details.code;
    this.httpStatus = details.httpStatus;
    this.cause = details.cause;
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
