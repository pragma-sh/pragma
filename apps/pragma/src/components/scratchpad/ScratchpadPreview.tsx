import { useEffect, useRef, useState } from "react";

// oxlint-disable-next-line import/default -- Vite synthesizes default URL export for worker query.
import frameRuntimeUrl from "@/components/scratchpad/scratchpad-frame-runtime.tsx?worker&url";
import { useScratchpadFrameBridge } from "@/components/scratchpad/use-scratchpad-frame-bridge";
import { buildScratchpadPreview } from "@/lib/mdx-preview";
import { scratchpadTheme, type ScratchpadTheme } from "@/lib/scratchpad-theme";

/** Id of the frame's theme block, rewritten in place when the desktop theme changes. */
const THEME_STYLE_ELEMENT_ID = "pragma-scratchpad-theme";

interface ScratchpadPreviewProps {
  source: string;
  filePath: string;
  worktreeId: string;
  getAttachedAgentTabId: () => string | null;
  onRequestAgentAttachment: () => Promise<boolean>;
}

/** Sandboxed live renderer for one scratchpad MDX component region. */
export function ScratchpadPreview({
  source,
  filePath,
  worktreeId,
  getAttachedAgentTabId,
  onRequestAgentAttachment,
}: ScratchpadPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef(crypto.randomUUID());
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);
  const [height, setHeight] = useState(96);

  useEffect(() => {
    let current = true;
    setBuilding(true);
    setError(null);
    void buildScratchpadPreview({ source, filePath, worktreeId })
      .then((bundle) => {
        if (current) {
          setSrcDoc(previewDocument(bundle.code, bundle.css, tokenRef.current, scratchpadTheme()));
        }
        return undefined;
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (current) setBuilding(false);
      });
    return () => {
      current = false;
    };
  }, [source, filePath, worktreeId]);

  useScratchpadFrameBridge({
    iframeRef,
    token: tokenRef.current,
    worktreeId,
    srcDoc,
    getAttachedAgentTabId,
    onRequestAgentAttachment,
    onRenderError: setError,
    onResize: setHeight,
  });

  if (building)
    return (
      <div className="grid min-h-24 place-items-center text-xs text-muted-foreground">
        Rendering component...
      </div>
    );
  if (error) return <pre className="m-4 whitespace-pre-wrap text-sm text-destructive">{error}</pre>;
  if (!srcDoc) return null;
  return (
    <iframe
      className="block w-full border-0 bg-transparent"
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ height }}
      title="Rendered MDX component"
    />
  );
}

function previewDocument(code: string, css: string, token: string, theme: ScratchpadTheme): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const runtimeUrl = new URL(frameRuntimeUrl, location.href).href;
  const bootstrap = bridgeBootstrap(token).replaceAll("</script", "<\\/script");
  const safeCode = code.replaceAll("</script", "<\\/script");
  const execution = import.meta.env.DEV
    ? `<script type="module" nonce="${nonce}">import ${JSON.stringify(runtimeUrl)};\n${safeCode}</script>`
    : `<script nonce="${nonce}" src="${escapeHtmlAttribute(runtimeUrl)}"></script><script nonce="${nonce}">${safeCode}</script>`;
  return `<!doctype html>
<html class="${theme.mode}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' blob: ${location.origin}; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:;">
<style id="${THEME_STYLE_ELEMENT_ID}">${theme.css}</style>
<style>*{box-sizing:border-box}html,body{background:transparent}body{margin:0;padding:.5rem;color:var(--foreground);font-family:var(--font-sans);font-size:13px;line-height:1.6}#root{max-width:64rem;margin:auto}.pragma-component-error{margin:1rem 0;padding:1rem;border:1px solid var(--destructive);border-radius:var(--radius-lg);color:var(--destructive);background:color-mix(in oklab,var(--destructive) 12%,transparent);font-size:.8125rem}.pragma-component-error pre{margin:.5rem 0 0;font-family:var(--font-mono);white-space:pre-wrap}${css}</style>
<script nonce="${nonce}">${bootstrap}</script>
</head><body><div id="root"></div>${execution}</body></html>`;
}

function bridgeBootstrap(token: string): string {
  return `(() => {
    const token = ${JSON.stringify(token)};
    globalThis.pragmaScratchpadToken = token;
    globalThis.$RefreshReg$ = () => {};
    globalThis.$RefreshSig$ = () => (type) => type;
    const pending = new Map();
    const progress = new Map();
    const request = (method, payload = {}) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      parent.postMessage({ channel: "pragma-scratchpad", token, type: "request", id, method, ...payload }, "*");
    });
    globalThis.pragmaScratchpad = {
      promptAgent: (text) => request("promptAgent", { text }),
      requestAgentAttachment: () => request("requestAgentAttachment"),
      subscribeAgentProgress: (tabIds, listener) => {
        const id = crypto.randomUUID();
        progress.set(id, listener);
        parent.postMessage({ channel: "pragma-scratchpad", token, type: "request", id, method: "subscribeAgentProgress", tabIds }, "*");
        return () => {
          progress.delete(id);
          parent.postMessage({ channel: "pragma-scratchpad", token, type: "request", id, method: "unsubscribeAgentProgress" }, "*");
        };
      },
    };
    addEventListener("message", (event) => {
      if (event.source !== parent || event.data?.channel !== "pragma-scratchpad" || event.data?.token !== token) return;
      if (event.data.type === "theme") {
        const style = document.getElementById(${JSON.stringify(THEME_STYLE_ELEMENT_ID)});
        if (style) style.textContent = event.data.css;
        document.documentElement.className = event.data.mode;
      }
      if (event.data.type === "progress") progress.get(event.data.id)?.(event.data.entries);
      if (event.data.type !== "response") return;
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.error) entry.reject(new Error(event.data.error)); else entry.resolve(event.data.value);
    });
    addEventListener("error", (event) => {
      const location = event.filename ? " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")" : "";
      parent.postMessage({ channel: "pragma-scratchpad", token, type: "render-error", message: event.message + location }, "*");
    });
    addEventListener("unhandledrejection", (event) => parent.postMessage({ channel: "pragma-scratchpad", token, type: "render-error", message: String(event.reason) }, "*"));
    const reportSize = () => parent.postMessage({ channel: "pragma-scratchpad", token, type: "resize", height: Math.ceil(document.documentElement.scrollHeight) }, "*");
    new ResizeObserver(reportSize).observe(document.documentElement);
    addEventListener("load", reportSize);
  })();`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
