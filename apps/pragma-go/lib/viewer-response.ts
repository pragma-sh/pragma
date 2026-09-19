import type { ScratchpadViewerCommand } from "@pragma-sh/scratchpad-viewer";

/** Settles one async viewer request without leaving rejected bridge promises hanging. */
export function respondToViewer(
  send: (command: ScratchpadViewerCommand) => void,
  requestId: string,
  operation: Promise<unknown>,
): void {
  void operation
    .then((value) => {
      send({ type: "response", requestId, value });
      return undefined;
    })
    .catch((cause: unknown) => {
      send({
        type: "response",
        requestId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return undefined;
    });
}
