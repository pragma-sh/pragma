"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import { PLATFORM_MARKS } from "@/components/platform-marks";
import { Button } from "@/components/ui/button";
import {
  archFromUserAgent,
  defaultTarget,
  detectPlatform,
  downloadRoute,
  PLATFORM_LABELS,
  type DownloadArch,
  type DownloadPlatform,
} from "@/lib/downloads";
import { downloadUrl } from "@/lib/shared";
import { cn } from "@/lib/utils";

interface NavigatorUAData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

interface Detected {
  platform: DownloadPlatform;
  href: string;
}

/** Chromium's client hints are the only reliable CPU signal; everything else guesses. */
async function hintedArch(uaData: NavigatorUAData | undefined): Promise<DownloadArch | null> {
  try {
    return archFromUserAgent(await architectureHint(uaData));
  } catch {
    // Hints are optional; the caller falls back to the user agent string.
    return null;
  }
}

async function architectureHint(uaData: NavigatorUAData | undefined): Promise<string> {
  const values = await uaData?.getHighEntropyValues?.(["architecture"]);
  return values?.architecture ?? "";
}

async function detectArch(uaData: NavigatorUAData | undefined): Promise<DownloadArch | null> {
  return (await hintedArch(uaData)) ?? archFromUserAgent(navigator.userAgent);
}

async function detect(): Promise<Detected | null> {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const platform = detectPlatform({
    userAgent: navigator.userAgent,
    platform: uaData?.platform ?? navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
  if (!platform) return null;
  const arch = await detectArch(uaData);
  return { platform, href: downloadRoute(defaultTarget(platform, arch)) };
}

interface DownloadButtonProps {
  className?: string;
  /**
   * `cta` reads "Download for macOS" (or "Download Pragma" before detection);
   * `nav` reads "Download" and collapses to the glyph below the `sm` breakpoint.
   */
  variant?: "cta" | "nav";
}

/** Glyph, target, and copy for a detection result; generic until the OS is known. */
function presentation(detected: Detected | null) {
  if (!detected) {
    return {
      Mark: Download,
      href: downloadUrl,
      ariaLabel: "Download Pragma",
      text: "Download Pragma",
    };
  }
  const label = PLATFORM_LABELS[detected.platform];
  return {
    Mark: PLATFORM_MARKS[detected.platform],
    href: detected.href,
    ariaLabel: `Download Pragma for ${label}`,
    text: `Download for ${label}`,
  };
}

/**
 * The site's one Download button. It server-renders as a generic link to the release
 * page, then — once the browser says which OS it runs on — shows that platform's mark
 * and points at `/download/{target}`, which redirects to the matching installer.
 */
export function DownloadButton({ className, variant = "cta" }: DownloadButtonProps) {
  const [detected, setDetected] = useState<Detected | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await detect();
      if (live) setDetected(result);
    })();
    return () => {
      live = false;
    };
  }, []);

  const { Mark, href, ariaLabel, text } = presentation(detected);

  return (
    <Button
      asChild
      className={cn("pill-cta gap-2", variant === "nav" && "max-sm:size-11 max-sm:p-0", className)}
    >
      <a href={href} aria-label={ariaLabel}>
        <Mark className="size-4" />
        {variant === "nav" ? <span className="max-sm:hidden">Download</span> : text}
      </a>
    </Button>
  );
}
