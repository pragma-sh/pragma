import type { Metadata } from "next";

import { DeepLinkForward } from "@/components/deep-link-forward";
import { deepLinkQuery } from "@/lib/deep-link";
import { pluginsRoute } from "@/lib/shared";

export const metadata: Metadata = {
  title: { absolute: "Install a Pragma plugin" },
  robots: { index: false },
};

/**
 * Web forwarder for `pragma://install-plugin`. Package identity is only a
 * selector: the app resolves the exact version, integrity, and reviewed
 * command against the official lock before anything runs.
 */
export default async function InstallPluginForwardPage(props: PageProps<"/install-plugin">) {
  const searchParams = await props.searchParams;
  return (
    <DeepLinkForward
      action="install-plugin"
      query={deepLinkQuery(searchParams)}
      title="Opening Pragma…"
      description="This link installs a reviewed plugin into the Pragma desktop app. Pragma shows the exact install command before anything runs."
      primaryLabel="Install in Pragma"
      secondary={{ label: "Browse plugins", href: pluginsRoute }}
    />
  );
}
