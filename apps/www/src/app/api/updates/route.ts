import {
  evaluateUpdates,
  fixtureManifest,
  loadGithubManifests,
  useDevFixture,
  type UpdateCheckResponse,
} from "@/lib/updates";

/** `GET /api/updates` — desktop poll endpoint. Never imports `@pragma/*`. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const documents = await availableManifests();
  if (documents.length === 0) {
    return Response.json({ available: false });
  }

  const platform = url.searchParams.get("platform") ?? "";
  const running = runningVersions(url);
  const body = evaluateUpdates({ documents, platform, running });
  return Response.json(withAbsoluteAssetUrl(body, url.origin));
}

async function availableManifests() {
  if (useDevFixture()) return [{ manifest: fixtureManifest() }];
  try {
    return await loadGithubManifests();
  } catch {
    return [];
  }
}

function runningVersions(url: URL) {
  return {
    ui: optionalSearchParam(url, "ui"),
    app: optionalSearchParam(url, "app"),
    server: optionalSearchParam(url, "server"),
    protocol: optionalSearchParam(url, "protocol"),
  };
}

function optionalSearchParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) ?? undefined;
}

function withAbsoluteAssetUrl(body: UpdateCheckResponse, origin: string): UpdateCheckResponse {
  if (!body.asset) return body;
  return {
    ...body,
    asset: { ...body.asset, url: absoluteAssetUrl(origin, body.asset.url) },
  };
}

function absoluteAssetUrl(origin: string, assetUrl: string): string {
  if (assetUrl.startsWith("http://") || assetUrl.startsWith("https://")) {
    return assetUrl;
  }
  return `${origin}${assetUrl}`;
}
