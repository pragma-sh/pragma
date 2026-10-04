import type { Metadata } from "next";
import { Download } from "lucide-react";

import { DownloadButton } from "@/components/download-button";
import { PLATFORM_MARKS } from "@/components/platform-marks";
import { Button } from "@/components/ui/button";
import { downloadRoute, PLATFORM_LABELS, type DownloadPlatform } from "@/lib/downloads";
import { appName, downloadUrl } from "@/lib/shared";

export const metadata: Metadata = {
  // The root layout template appends "— Pragma".
  title: "Downloads",
  description:
    "Signed Pragma installers for macOS (Apple silicon and Intel), Windows (x64 and ARM64), and Linux (.deb and .rpm).",
};

/** One installer a platform card lists. */
interface Installer {
  href: string;
  /** Machine family, as shown in the row. */
  arch: string;
  /** Package format, shown as a mono chip. */
  format: string;
  /** Accessible name of the link; names the platform, since rows read alone. */
  label: string;
  /** The build that suits most machines — drawn as the row's primary pill. */
  recommended?: boolean;
  note?: string;
}

interface PlatformInstaller {
  platform: DownloadPlatform;
  blurb: string;
  installers: Installer[];
}

const PLATFORMS: PlatformInstaller[] = [
  {
    platform: "macos",
    blurb: "Every Mac sold since 2023 is Apple silicon — choose Intel only for an older machine.",
    installers: [
      {
        href: downloadRoute("darwin-aarch64"),
        arch: "Apple silicon",
        format: ".dmg",
        label: "macOS (Apple silicon)",
        recommended: true,
      },
      {
        href: downloadRoute("darwin-x86_64"),
        arch: "Intel",
        format: ".dmg",
        label: "macOS (Intel)",
      },
    ],
  },
  {
    platform: "windows",
    blurb: "Pick the installer that matches your processor, not your Windows edition.",
    installers: [
      {
        href: downloadRoute("windows-x86_64"),
        arch: "x64",
        format: ".exe",
        label: "Windows (x64)",
        recommended: true,
      },
      {
        href: downloadRoute("windows-aarch64"),
        arch: "ARM64",
        format: ".exe",
        label: "Windows (ARM64)",
      },
    ],
  },
  {
    platform: "linux",
    blurb:
      "Choose the package format your distribution uses — .deb for Ubuntu and Debian, .rpm for Fedora and openSUSE. Both architectures are available in each.",
    installers: [
      {
        href: downloadRoute("linux-x86_64-deb"),
        arch: "x64",
        format: ".deb",
        label: "Linux x64 (.deb)",
        recommended: true,
      },
      {
        href: downloadRoute("linux-x86_64-rpm"),
        arch: "x64",
        format: ".rpm",
        label: "Linux x64 (.rpm)",
      },
      {
        href: downloadRoute("linux-aarch64-deb"),
        arch: "ARM64",
        format: ".deb",
        label: "Linux ARM64 (.deb)",
      },
      {
        href: downloadRoute("linux-aarch64-rpm"),
        arch: "ARM64",
        format: ".rpm",
        label: "Linux ARM64 (.rpm)",
      },
    ],
  },
];

/** One installer row: machine family, package format, and its download pill. */
function InstallerRow({ installer }: { installer: Installer }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">{installer.arch}</p>
        {installer.note && (
          <p className="text-muted-foreground mt-1 text-xs leading-5">{installer.note}</p>
        )}
      </div>
      <span className="bg-elevated text-muted-foreground rounded-sm px-1.5 py-0.5 font-mono text-xs">
        {installer.format}
      </span>
      <Button
        asChild
        variant={installer.recommended ? "default" : "secondary"}
        className="pill-cta gap-2"
      >
        <a href={installer.href} aria-label={`Download Pragma for ${installer.label}`}>
          <Download className="size-4" aria-hidden />
          Download
        </a>
      </Button>
    </li>
  );
}

/** One platform card: its mark, a note on choosing, and its installer rows. */
function PlatformCard({ platform, blurb, installers }: PlatformInstaller) {
  const Mark = PLATFORM_MARKS[platform];
  return (
    <article className="border-border bg-card flex flex-col overflow-hidden rounded-xl border">
      <header className="flex items-start gap-4 border-b p-6">
        <span className="bg-elevated text-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
          <Mark className="size-5" />
        </span>
        <div>
          <h2 className="text-[22px] font-bold tracking-[-0.036em]">{PLATFORM_LABELS[platform]}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{blurb}</p>
        </div>
      </header>
      <ul className="divide-border divide-y">
        {installers.map((installer) => (
          <InstallerRow key={installer.href} installer={installer} />
        ))}
      </ul>
    </article>
  );
}

/** Displays the desktop installer picker. */
export default function DownloadsPage() {
  return (
    <main className="flex-1">
      <header className="mx-auto w-full max-w-6xl px-6 pt-16 pb-10 sm:pt-24">
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-[0.2em]">
          {appName} Downloads
        </p>
        <h1 className="font-heading type-display-lg mt-4 max-w-3xl text-balance">
          Signed installers for every desktop.
        </h1>
        <p className="text-muted-foreground mt-6 max-w-2xl text-base leading-7">
          Pragma runs on macOS, Windows, and Linux. Every link below resolves to the latest desktop
          release — built and signed by the release pipeline, never mirrored.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <DownloadButton />
          <Button asChild variant="secondary" className="pill-cta gap-2">
            <a href={downloadUrl}>Release notes on GitHub</a>
          </Button>
        </div>
      </header>

      <section aria-label="Installers by platform" className="border-border border-t px-6 py-16">
        <div className="mx-auto grid w-full max-w-6xl gap-6 md:grid-cols-3">
          {PLATFORMS.map((platform) => (
            <PlatformCard key={platform.platform} {...platform} />
          ))}
        </div>
      </section>

      <section aria-label="About the installers" className="border-border border-t px-6 py-16">
        <div className="mx-auto w-full max-w-6xl">
          <p className="text-muted-foreground max-w-2xl text-sm leading-6">
            Windows is offered in x64 and ARM64 builds, macOS in Apple silicon and Intel builds, and
            Linux as .deb and .rpm packages for both architectures. Older releases live on the{" "}
            <a className="text-foreground underline underline-offset-4" href={downloadUrl}>
              GitHub releases page
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
