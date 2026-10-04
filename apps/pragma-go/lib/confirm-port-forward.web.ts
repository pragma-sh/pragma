import type { OpenPort } from "@pragma/sdk";

/** Browser confirmation twin for the Expo web build. */
export async function confirmPortForward(port: OpenPort): Promise<boolean> {
  return globalThis.confirm(
    `Forward port ${port.port}?\n\n${port.process} will be reachable through your configured public tunnel.`,
  );
}
