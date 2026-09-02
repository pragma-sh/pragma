import { toast } from "sonner";

import { browserOpenExternal } from "@/lib/tauri";

/**
 * Opens a URL in the user's default browser, surfacing a toast when the host
 * refuses. Sign-in flows depend on that browser hop, so a silent failure looks
 * to the user like a dead button.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    await browserOpenExternal(url);
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? `Could not open browser: ${cause.message}`
        : "Could not open browser",
    );
  }
}
