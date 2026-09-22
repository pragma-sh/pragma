import { findInstallerUrl, isDownloadTarget, loadLatestReleaseAssets } from "@/lib/downloads";
import { downloadUrl } from "@/lib/shared";

/**
 * `GET /download/{target}` — redirects to the latest desktop release's installer for
 * `target`. Asset names carry the version, so there is no stable GitHub URL to link to
 * directly. Anything that goes wrong lands on the release page, never on an error.
 */
export async function GET(_req: Request, { params }: RouteContext<"/download/[target]">) {
  const { target } = await params;
  if (!isDownloadTarget(target)) return Response.redirect(downloadUrl, 302);
  try {
    const assets = await loadLatestReleaseAssets();
    return Response.redirect(findInstallerUrl(assets, target) ?? downloadUrl, 302);
  } catch {
    return Response.redirect(downloadUrl, 302);
  }
}
