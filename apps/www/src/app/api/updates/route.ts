import { evaluateUpdate, fixtureManifest, loadGithubManifest, useDevFixture } from "@/lib/updates";

/** `GET /api/updates` — desktop poll endpoint. Never imports `@pragma/*`. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") ?? "";
  const running = {
    ui: url.searchParams.get("ui") ?? undefined,
    app: url.searchParams.get("app") ?? undefined,
    server: url.searchParams.get("server") ?? undefined,
    protocol: url.searchParams.get("protocol") ?? undefined,
  };

  let manifest = useDevFixture() ? fixtureManifest() : null;
  if (!manifest) {
    try {
      manifest = await loadGithubManifest();
    } catch {
      manifest = null;
    }
  }
  if (!manifest) {
    return Response.json({ available: false });
  }

  const body = evaluateUpdate({ manifest, platform, running });
  if (body.asset) {
    body.asset = {
      ...body.asset,
      url: absoluteAssetUrl(url.origin, body.asset.url),
    };
  }
  return Response.json(body);
}

function absoluteAssetUrl(origin: string, assetUrl: string): string {
  if (assetUrl.startsWith("http://") || assetUrl.startsWith("https://")) {
    return assetUrl;
  }
  return `${origin}${assetUrl}`;
}
