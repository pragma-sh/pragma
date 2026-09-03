"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { pragmaDeepLinkUrl } from "@/lib/deep-link";

/**
 * One deep-link hand-off page: a web route (`/{action}?...`) that relays its
 * query string to `pragma://{action}` on the desktop app.
 *
 * The hand-off is attempted once automatically on mount; the same target is
 * also rendered as the primary pill anchor, because browsers that suppress
 * programmatic external-protocol launches without a fresh user activation
 * still open it on an explicit click. Everything below the fold is fallback
 * copy for a machine where Pragma is not installed.
 */
export function DeepLinkForward(props: {
  /** `pragma://` action to relay to, e.g. `open` or `install-plugin`. */
  action: string;
  /** Raw query string (no leading `?`) forwarded verbatim. */
  query: string;
  title: string;
  description: string;
  primaryLabel: string;
  secondary: { label: string; href: string };
}) {
  const target = pragmaDeepLinkUrl(props.action, props.query);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    // replace() keeps the forwarder out of history, so Back returns to where
    // the link was clicked instead of to this page.
    window.location.replace(target);
  }, [target]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-16 sm:py-24">
      <div className="mx-auto w-full max-w-xl border bg-card/40 p-8 sm:p-10">
        <h1 className="text-3xl font-semibold tracking-tight">{props.title}</h1>
        <p className="mt-4 leading-6 text-muted-foreground">{props.description}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild className="pill-cta">
            <a href={target}>{props.primaryLabel}</a>
          </Button>
          <Button asChild className="pill-cta" variant="secondary">
            <a href={props.secondary.href}>{props.secondary.label}</a>
          </Button>
        </div>
        <p className="mt-8 break-all border-t pt-4 font-mono text-[11px] leading-5 text-muted-foreground">
          {target}
        </p>
      </div>
    </main>
  );
}
