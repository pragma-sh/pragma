import { DEV_UI_OVERLAY } from "@/lib/updates";

/** Overlay bytes named by the development fixture's `assets.ui` URL. */
export async function GET(): Promise<Response> {
  return new Response(Uint8Array.from(DEV_UI_OVERLAY).buffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="ui-overlay.tar"',
      "Cache-Control": "no-store",
    },
  });
}
