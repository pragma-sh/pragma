import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";

import { appDescription, appName, siteUrl } from "@/lib/shared";

import "./global.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
/*
 * The artboard body voice (`DESIGN.md`). Bound to the `font-body` utility, which
 * only the marketing route group wears — `/docs` stays on Geist Sans. The
 * OpenType character variants that make the voice live on `.artboard`, because
 * `next/font` has no hook for `font-feature-settings`.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: appName, template: `%s — ${appName}` },
  description: appDescription,
  // The desktop app's own icon, so the tab and the nav mark match the product.
  icons: { icon: "/icon.png", apple: "/icon.png" },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} font-sans antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
