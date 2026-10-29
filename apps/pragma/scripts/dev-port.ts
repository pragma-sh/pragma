import { createServer } from "node:net";

export const DEFAULT_DEV_PORT = 1420;

const MAX_PORT = 65_534;
const PORT_SEARCH_SIZE = 100;

type PortAvailability = (port: number) => Promise<boolean>;

/** Parses the dev-server port shared by Vite and the Tauri launcher. */
export function resolveDevPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DEV_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`PRAGMA_DEV_PORT must be an integer between 1 and ${MAX_PORT}, got ${value}`);
  }
  return port;
}

/** Returns whether a port can be bound on the local machine. */
function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, exclusive: true }, () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

/** Finds a free Vite port whose adjacent HMR port is also free. */
export async function findAvailableDevPort(
  isAvailable: PortAvailability = portIsAvailable,
  preferredPort = DEFAULT_DEV_PORT,
): Promise<number> {
  const search = async (port: number): Promise<number> => {
    if (port >= preferredPort + PORT_SEARCH_SIZE || port > MAX_PORT) {
      throw new Error(
        `Could not find an available dev-server port between ${preferredPort} and ${Math.min(
          preferredPort + PORT_SEARCH_SIZE - 1,
          MAX_PORT + 1,
        )}`,
      );
    }
    const [viteAvailable, hmrAvailable] = await Promise.all([
      isAvailable(port),
      isAvailable(port + 1),
    ]);
    return viteAvailable && hmrAvailable ? port : search(port + 2);
  };

  return search(preferredPort);
}
