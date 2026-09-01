import { llms } from "fumadocs-core/source";

import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const index = llms(source).index();
  const [title, ...rest] = index.split("\n");

  // The agent-facing note goes right under the title so it is seen before the page list.
  return new Response(
    [
      title,
      "",
      "Append `.md` to any /docs page URL to fetch it as raw markdown (for example, `/docs/user-guide/core-model.md`).",
      "",
      ...rest,
    ].join("\n"),
  );
}
