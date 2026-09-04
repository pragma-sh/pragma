import type { Metadata } from "next";

import { DeepLinkForward } from "@/components/deep-link-forward";
import { deepLinkQuery } from "@/lib/deep-link";

export const metadata: Metadata = {
  title: { absolute: "Opening Pragma…" },
  robots: { index: false },
};

/**
 * Web forwarder for `pragma://open` — the target of the "Open worktree in
 * Pragma" link in the pull-request footer, which GitHub's sanitizer keeps only
 * as an `https` href. Every query param is relayed to the deep link; a
 * `worktree` id resolves only on the machine that owns it, and Pragma falls
 * back to the current selection anywhere else.
 */
export default async function OpenForwardPage(props: PageProps<"/open">) {
  const searchParams = await props.searchParams;
  return (
    <DeepLinkForward
      action="open"
      query={deepLinkQuery(searchParams)}
      title="Opening Pragma…"
      description="This link hands off to the Pragma desktop app. If nothing opens, Pragma may not be installed on this machine — the worktree only resolves where it exists."
      primaryLabel="Open in Pragma"
      secondary={{ label: "About Pragma", href: "/" }}
    />
  );
}
