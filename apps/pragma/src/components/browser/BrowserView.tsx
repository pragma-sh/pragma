import { useCallback, useEffect, useRef, useState } from "react";

import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  CircleAlert,
  Code,
  MoreHorizontal,
  Paintbrush,
  RotateCw,
  Search,
} from "lucide-react";

import type { Tab } from "@pragma/constants";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton, TOOLBAR_BUTTON_CLASS } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DesignModePopover } from "@/components/browser/DesignModePopover";
import { useBrowserFind } from "@/components/browser/use-browser-find";
import { useDesignMode } from "@/components/browser/use-design-mode";
import { FindReplaceBar } from "@/components/find-replace/FindReplaceBar";
import { useTabDrag } from "@/components/tabs/tab-drag-context";
import {
  BROWSER_LOAD_TIMEOUT_MS,
  BROWSER_START_URL,
  rectToBounds,
  screenshotBounds,
} from "@/lib/browser-manager";
import { isLocalPortUrl } from "@/lib/design-mode";
import { useNativeOverlaySuppressed } from "@/lib/native-overlay";
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
  browserSnapshot,
  onBrowserLoad,
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
// fallow-ignore-next-line complexity -- orchestrates the native webview lifecycle (create/position/show/hide) plus toolbar chrome; find-in-page and design mode each add only a hook call and a toolbar control on top of pre-existing branching.
export function BrowserView({ tab, active }: BrowserViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { isDragging } = useTabDrag();
  // An open HTML overlay (dropdown/popover) must float above the native webview.
  const overlaySuppressed = useNativeOverlaySuppressed();
  // A still of the live page painted in the placeholder while the webview is
  // hidden behind an overlay, so the pane looks unchanged. `null` when the live
  // webview is shown (or genuinely hidden, e.g. inactive/dragging).
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [address, setAddress] = useState(tab.url ?? "");
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentLoadUrlRef = useRef<string | null>(null);
  const find = useBrowserFind(tab.id);
  const design = useDesignMode(tab.id, tab.url);
  // Design mode only helps on a local dev server (the agent needs source it can
  // edit), so its toggle is promoted to the toolbar there and tucked into the
  // overflow menu everywhere else.
  const designPromoted = isLocalPortUrl(tab.url);

  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current !== null) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const failLoad = useCallback(
    (url: string) => {
      clearLoadTimeout();
      setFailedUrl(url);
    },
    [clearLoadTimeout],
  );

  const beginLoad = useCallback(
    (url: string) => {
      clearLoadTimeout();
      setFailedUrl(null);
      currentLoadUrlRef.current = url;
      loadTimeoutRef.current = setTimeout(() => failLoad(url), BROWSER_LOAD_TIMEOUT_MS);
    },
    [clearLoadTimeout, failLoad],
  );

  // Cmd/Ctrl+F while the React chrome (not the native page) holds focus; the
  // page-content case is forwarded via `onBrowserFindRequest` (see
  // `focus_script`/`FIND_SENTINEL_SCHEME` in browser.rs).
  useEffect(() => {
    if (!active) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      const modifierHeld = navigator.platform.toUpperCase().includes("MAC")
        ? event.metaKey
        : event.ctrlKey;
      if (event.key.toLowerCase() === "f" && modifierHeld && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        find.openBar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- find.openBar is stable per tabId; tabId doesn't change for a mounted BrowserView.
  }, [active, find.openBar]);

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

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onBrowserLoad((load) => {
      if (load.tabId !== tab.id) {
        return;
      }
      if (load.status === "started") {
        beginLoad(load.url);
      } else if (load.status === "finished") {
        clearLoadTimeout();
        setFailedUrl(null);
      } else {
        failLoad(currentLoadUrlRef.current ?? load.url);
      }
    })
      .then((stop) => {
        unlisten = stop;
        return stop;
      })
      .catch(() => undefined);
    return () => {
      clearLoadTimeout();
      unlisten?.();
    };
  }, [beginLoad, clearLoadTimeout, failLoad, tab.id]);

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

    if (failedUrl) {
      setSnapshot(null);
      void browserSetVisible(tab.id, false);
      return;
    }

    // A tab drag needs the whole pane free as an HTML drop target. `hide()` alone
    // doesn't reliably stop WebKit from keeping the native webview as a drop
    // target, so collapse it to zero size too; the restore branch re-applies real
    // bounds on drop. No snapshot — the pane shows drop zones, not the page.
    if (active && isDragging) {
      setSnapshot(null);
      void browserSetVisible(tab.id, false);
      void browserSetBounds(tab.id, { x: 0, y: 0, width: 0, height: 0 });
      return;
    }

    // An HTML overlay (dropdown/popover) is open over this pane. The native
    // webview composites above all HTML, so it has to hide for the overlay to
    // show — but capture a still of the live page FIRST (while it's on screen)
    // and paint it in the placeholder so the pane looks unchanged behind the
    // overlay. Hide only after the capture resolves (or fails).
    if (active && overlaySuppressed) {
      let cancelled = false;
      void (async () => {
        try {
          const still = await browserSnapshot(
            screenshotBounds(
              element.getBoundingClientRect(),
              window.screenX,
              window.screenY,
              window.devicePixelRatio,
            ),
          );
          if (!cancelled) {
            setSnapshot(still);
          }
        } catch {
          // Capture unavailable; fall back to a plain hide (dark placeholder).
        }
        if (!cancelled) {
          void browserSetVisible(tab.id, false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // Live and visible (active, no drag, no overlay), or genuinely hidden
    // (inactive). Either way drop any snapshot; while shown, follow the rect.
    setSnapshot(null);
    void browserSetVisible(tab.id, active);
    if (!active) {
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
  }, [tab.id, active, isDragging, overlaySuppressed, failedUrl]);

  const navigateToAddress = useCallback(
    (value: string) => {
      const url = value.trim();
      if (url) {
        beginLoad(url);
        void browserNavigate(tab.id, url).catch(() => failLoad(url));
      }
    },
    [beginLoad, failLoad, tab.id],
  );

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      navigateToAddress(address);
    },
    [address, navigateToAddress],
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
    <div className="flex h-full w-full flex-col bg-canvas">
      <div
        className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-elevated px-2"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Back"
          size="icon-sm"
          variant="ghost"
          onClick={() => void browserBack(tab.id)}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Forward"
          size="icon-sm"
          variant="ghost"
          onClick={() => void browserForward(tab.id)}
        >
          <ArrowRight />
        </IconButton>
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Reload"
          size="icon-sm"
          variant="ghost"
          onClick={() => void browserReload(tab.id)}
        >
          <RotateCw />
        </IconButton>
        <form className="min-w-0 flex-1" onSubmit={submitAddress}>
          <Input
            aria-label="Address"
            className="h-8 bg-canvas text-sm text-foreground"
            placeholder="Enter a URL"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                navigateToAddress(event.currentTarget.value);
              }
            }}
          />
        </form>
        {designPromoted ? (
          <IconButton
            aria-pressed={design.enabled}
            className={design.enabled ? "bg-muted text-foreground" : TOOLBAR_BUTTON_CLASS}
            label="Design mode"
            size="icon-sm"
            variant="ghost"
            onClick={() => design.setEnabled(!design.enabled)}
          >
            <Paintbrush />
          </IconButton>
        ) : null}
        {design.changes.length > 0 ? (
          <DesignModePopover
            changes={design.changes}
            pageUrl={tab.url ?? address}
            onApplied={design.clear}
            onRemove={design.remove}
          />
        ) : null}
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Dev tools"
          size="icon-sm"
          variant="ghost"
          onClick={() => void browserDevtools(tab.id)}
        >
          <Code />
        </IconButton>
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Open externally"
          size="icon-sm"
          variant="ghost"
          onClick={() => void browserOpenExternal(tab.url ?? address)}
        >
          <ArrowUpRight />
        </IconButton>
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Screenshot"
          size="icon-sm"
          variant="ghost"
          onClick={takeScreenshot}
        >
          <Camera />
        </IconButton>
        <IconButton
          className={TOOLBAR_BUTTON_CLASS}
          label="Find in page"
          size="icon-sm"
          variant="ghost"
          onClick={find.openBar}
        >
          <Search />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              className={TOOLBAR_BUTTON_CLASS}
              label="More options"
              size="icon-sm"
              variant="ghost"
            >
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {designPromoted ? null : (
              <DropdownMenuItem onSelect={() => design.setEnabled(!design.enabled)}>
                <Paintbrush />
                {design.enabled ? "Exit design mode" : "Design mode"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void browserClearData(tab.id)}>
              Clear browsing data
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative min-h-0 flex-1" ref={contentRef}>
        {failedUrl ? (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas p-6">
            <div className="flex max-w-md flex-col items-center text-center">
              <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-border bg-elevated text-muted-foreground shadow-sm">
                <CircleAlert className="size-5" />
              </div>
              <h2 className="text-base font-semibold text-foreground">
                This page couldn't be reached
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Check the address and make sure the server is running, then try again.
              </p>
              <p className="mt-3 max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                {failedUrl}
              </p>
              <Button className="mt-5" onClick={() => navigateToAddress(failedUrl)}>
                <RotateCw />
                Try again
              </Button>
            </div>
          </div>
        ) : snapshot ? (
          <img
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            src={snapshot}
          />
        ) : null}
        {failedUrl ? null : (
          <FindReplaceBar
            currentMatch={find.currentMatch}
            findPlaceholder="Find on page"
            ignoreCase={find.ignoreCase}
            matchCount={find.matchCount}
            onClose={find.closeBar}
            onIgnoreCaseChange={find.setIgnoreCase}
            onNext={find.findNext}
            onPrevious={find.findPrevious}
            onQueryChange={find.setQuery}
            open={find.open}
            query={find.query}
          />
        )}
      </div>
    </div>
  );
}
