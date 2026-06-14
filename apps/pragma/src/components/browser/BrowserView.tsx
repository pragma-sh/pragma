import { useCallback, useEffect, useRef, useState } from "react";

import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Code,
  MoreHorizontal,
  RotateCw,
} from "lucide-react";

import type { Tab } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import { BROWSER_START_URL, rectToBounds, screenshotBounds } from "@/lib/browser-manager";
import {
  browserBack,
  browserClearData,
  browserCreate,
  browserDevtools,
  browserForward,
  browserFrameHeight,
  browserNavigate,
  browserOpenExternal,
  browserReload,
  browserScreenshot,
  browserSetBounds,
  browserSetVisible,
} from "@/lib/tauri";

interface BrowserViewProps {
  tab: Tab;
  /** Whether this tab is the visible one in its worktree. */
  active: boolean;
}

/**
 * Chrome (toolbar + address bar) for a browser tab. The page itself lives in a
 * native child webview that floats over the placeholder `<div>`; this component
 * keeps that webview created, positioned, and shown/hidden in sync with React.
 */
export function BrowserView({ tab, active }: BrowserViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { isDragging } = useTabDrag();
  const [address, setAddress] = useState(tab.url ?? "");

  // Latest `active`, readable from the async create callback without re-creating it.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Title-bar height (logical px). Tauri positions child webviews relative to the
  // window FRAME, but `getBoundingClientRect` is relative to the content viewport
  // below the title bar. We recover the inset as `frameHeight - innerHeight` (the
  // frame height comes from Rust; macOS reports it nowhere else) and shift the
  // webview down by it.
  const titleBarRef = useRef(0);

  const boundsFor = (element: HTMLElement) => {
    const bounds = rectToBounds(element.getBoundingClientRect());
    return { ...bounds, y: bounds.y + titleBarRef.current };
  };

  // Reflect navigation-driven URL changes (from the native webview) in the bar.
  useEffect(() => {
    setAddress(tab.url ?? "");
  }, [tab.url]);

  // Resolve the title-bar inset once, then realign the (already-created) webview.
  useEffect(() => {
    let cancelled = false;
    async function resolveInset() {
      try {
        const frameHeight = await browserFrameHeight();
        if (cancelled) {
          return;
        }
        titleBarRef.current = Math.max(0, frameHeight - window.innerHeight);
        if (activeRef.current && contentRef.current) {
          await browserSetBounds(tab.id, boundsFor(contentRef.current));
        }
      } catch {
        // Frame geometry unavailable; fall back to a zero inset.
      }
    }
    void resolveInset();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on tab.id; boundsFor reads refs.
  }, [tab.id]);

  // Create the native webview on mount; hide (not destroy) it on unmount so the
  // page survives worktree/project switches. Destruction happens centrally in
  // `workspace.closeTab`. `browser_create` is async, so the visibility/bounds
  // effect below can't position the webview until it exists — re-apply bounds and
  // visibility once creation resolves, otherwise the overlay keeps its (possibly
  // stale) create-time placement and ends up covering the toolbar.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    let cancelled = false;
    async function createAndAlign(el: HTMLDivElement) {
      try {
        await browserCreate(tab.id, tab.url ?? BROWSER_START_URL, boundsFor(el));
        if (cancelled || !contentRef.current) {
          return;
        }
        await browserSetVisible(tab.id, activeRef.current);
        if (activeRef.current) {
          await browserSetBounds(tab.id, boundsFor(contentRef.current));
        }
      } catch {
        // Webview may have been closed mid-flight; ignore.
      }
    }
    void createAndAlign(element);
    return () => {
      cancelled = true;
      void browserSetVisible(tab.id, false);
    };
    // Only (re)create per tab; later `tab.url` changes come from in-webview
    // navigation and must NOT tear down and recreate the live webview.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on tab.id only.
  }, [tab.id]);

  // Track visibility + bounds. The overlay is native, so CSS can't hide it — we
  // explicitly show/hide and follow the placeholder rect while active. While a
  // tab drag is in flight the native overlay would float above (and swallow) the
  // HTML drop zones, so hide it for the duration and restore it on drop.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const visible = active && !isDragging;
    void browserSetVisible(tab.id, visible);
    if (!visible) {
      // `hide()` alone doesn't reliably stop WebKit from keeping the native
      // webview as a drop target, so drags over a browser pane's content (its
      // left, center, and bottom — everything below the HTML toolbar) get
      // swallowed and never reach the drop overlay. While dragging, also collapse
      // the webview to zero size so the whole pane is free for the HTML overlay
      // underneath; the restore branch below re-applies real bounds on drop.
      if (active && isDragging) {
        void browserSetBounds(tab.id, { x: 0, y: 0, width: 0, height: 0 });
      }
      return;
    }
    const update = () => void browserSetBounds(tab.id, boundsFor(element));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [tab.id, active, isDragging]);

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (address.trim()) {
        void browserNavigate(tab.id, address.trim());
      }
    },
    [address, tab.id],
  );

  const takeScreenshot = useCallback(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    void browserScreenshot(
      screenshotBounds(
        element.getBoundingClientRect(),
        window.screenX,
        window.screenY,
        window.devicePixelRatio,
      ),
    );
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full flex-col bg-[#0b0d10]">
        <div
          className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 bg-[#11151b] px-2"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            aria-label="Back"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={() => void browserBack(tab.id)}
          >
            <ArrowLeft />
          </Button>
          <Button
            aria-label="Forward"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={() => void browserForward(tab.id)}
          >
            <ArrowRight />
          </Button>
          <Button
            aria-label="Reload"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={() => void browserReload(tab.id)}
          >
            <RotateCw />
          </Button>
          <form className="min-w-0 flex-1" onSubmit={submitAddress}>
            <Input
              aria-label="Address"
              className="h-8 bg-[#0b0d10] text-sm text-slate-200"
              placeholder="Enter a URL"
              spellCheck={false}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </form>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Open dev tools"
                className="text-slate-300 hover:bg-white/10 hover:text-white"
                size="icon-sm"
                variant="ghost"
                onClick={() => void browserDevtools(tab.id)}
              >
                <Code />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open dev tools</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Open in default browser"
                className="text-slate-300 hover:bg-white/10 hover:text-white"
                size="icon-sm"
                variant="ghost"
                onClick={() => void browserOpenExternal(tab.url ?? address)}
              >
                <ArrowUpRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in default browser</TooltipContent>
          </Tooltip>
          <Button
            aria-label="Save screenshot"
            className="text-slate-300 hover:bg-white/10 hover:text-white"
            size="icon-sm"
            variant="ghost"
            onClick={takeScreenshot}
          >
            <Camera />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="More options"
                className="text-slate-300 hover:bg-white/10 hover:text-white"
                size="icon-sm"
                variant="ghost"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void browserClearData(tab.id)}>
                Clear browsing data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-h-0 flex-1" ref={contentRef} />
      </div>
    </TooltipProvider>
  );
}
