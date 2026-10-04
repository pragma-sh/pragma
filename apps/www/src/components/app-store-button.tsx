"use client";

import { ArrowUpRight } from "lucide-react";
import { renderSVG } from "uqr";

import { AppleMark } from "@/components/platform-marks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { appStoreUrl } from "@/lib/shared";
import { cn } from "@/lib/utils";

/** The listing URL as a QR code; a constant, so it is rendered once per module load. */
const APP_STORE_QR = `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(appStoreUrl))}`;

/**
 * Secondary pill that opens a dialog for getting Pragma Go onto an iPhone: a QR code to
 * scan from a desktop browser, and a direct App Store link for a visitor already on one.
 */
export function AppStoreButton({ className }: { className?: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" className={cn("pill-cta gap-2", className)}>
          <AppleMark className="size-4" />
          App Store
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle>Get Pragma Go for iPhone</DialogTitle>
          <DialogDescription>
            Scan with your iPhone camera to open the App Store, then pair it from Settings → Pragma
            Go on your desktop.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center">
          <img
            src={APP_STORE_QR}
            alt="QR code linking to Pragma Go on the App Store"
            width={192}
            height={192}
            className="size-48 rounded-lg bg-white p-3"
          />
        </div>
        <Button asChild className="pill-cta gap-2">
          <a href={appStoreUrl} target="_blank" rel="noopener noreferrer">
            <AppleMark className="size-4" />
            Open in the App Store
            <ArrowUpRight className="size-4" />
          </a>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
