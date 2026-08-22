import { DEV_UI_OVERLAY } from "@/lib/updates";

/** Overlay bytes named by the development fixture's `assets.ui` URL. */
export async function GET(): Promise<Response> {
  return new Response(DEV_UI_OVERLAY, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="ui-overlay.txt"',
      "Cache-Control": "no-store",
    },
  });
}
