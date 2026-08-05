import { routes } from "./routes";
import type { Transport } from "./transport";
import type { HostTheme } from "./types/theme";

/** Options for {@link ThemeClient.get}. */
export interface GetThemeOptions {
  /**
   * Absolute root of a project whose `.pragma/theme.json` should layer over the
   * global one. Omit for the global theme alone.
   */
  root?: string;
  signal?: AbortSignal;
}

/**
 * Gateway namespace for the host's user theme (`.pragma/theme.json`).
 *
 * The host returns overrides only — never the desktop's shipped defaults — so a
 * client mirrors the user's customisation on top of its own base palette.
 */
export class ThemeClient {
  constructor(private readonly transport: Transport) {}

  /** Fetches the host's merged theme overrides. */
  get(options: GetThemeOptions = {}): Promise<HostTheme> {
    const query = options.root ? `?root=${encodeURIComponent(options.root)}` : "";
    return this.transport.request<HostTheme>(`${routes.theme}${query}`, {
      signal: options.signal,
    });
  }
}
