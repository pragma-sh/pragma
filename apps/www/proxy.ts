import { NextResponse, type NextRequest } from "next/server";
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";

import { docsContentRoute, docsRoute } from "@/lib/shared";

export const config = { matcher: "/docs/:path*" };

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

/** Serves the raw markdown of a docs page when the client asks for it (`.md` suffix or `Accept`). */
export default function proxy(request: NextRequest) {
  const suffixed = rewriteSuffix(request.nextUrl.pathname);
  if (suffixed) {
    return NextResponse.rewrite(new URL(suffixed, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const negotiated = rewriteDocs(request.nextUrl.pathname);

    if (negotiated) {
      return NextResponse.rewrite(new URL(negotiated, request.nextUrl), {
        // this URL has two representations, selected by `Accept`
        headers: { Vary: "Accept" },
      });
    }
  }

  return NextResponse.next();
}
