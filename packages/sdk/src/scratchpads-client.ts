// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { routes } from "./routes";
import type { Transport } from "./transport";
import type { GetScratchpadsOptions, ScratchpadFile } from "./types/scratchpads";

/**
 * Gateway namespace for a worktree's managed scratchpads.
 *
 * The host lists the worktree's scratchpad directory and parses each file's
 * managed frontmatter, so every client sees the same contract the desktop does:
 * the MDX source plus the agent tab the scratchpad is attached to.
 */
export class ScratchpadsClient {
  constructor(private readonly transport: Transport) {}

  /** Lists every managed scratchpad in one worktree, source included. */
  getScratchpads(options: GetScratchpadsOptions): Promise<ScratchpadFile[]> {
    const query = `?root=${encodeURIComponent(options.root)}`;
    return this.transport.request<ScratchpadFile[]>(`${routes.scratchpads}${query}`, {
      signal: options.signal,
    });
  }
}
