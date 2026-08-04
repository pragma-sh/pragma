import { useEffect, useRef, useState } from "react";

import type { ScratchpadAgentProgress } from "@pragma/scratchpad";

// oxlint-disable-next-line import/default -- Vite synthesizes default URL export for worker query.
import frameRuntimeUrl from "@/components/scratchpad/scratchpad-frame-runtime.tsx?worker&url";
import { buildScratchpadPreview } from "@/lib/mdx-preview";
import { scratchpadTheme, type ScratchpadTheme } from "@/lib/scratchpad-theme";
import { scratchpadPromptAgent } from "@/lib/tauri";
import { THEME_CHANGED_EVENT } from "@/lib/theme";
import { useAgentStatusSnapshot } from "@/state/agent-status-store";
import { useWorkspace } from "@/state/workspace-context";

/** Id of the frame's theme block, rewritten in place when the desktop theme changes. */
const THEME_STYLE_ELEMENT_ID = "pragma-scratchpad-theme";

interface ScratchpadPreviewProps {
  source: string;
  filePath: string;
  worktreeId: string;
  getAttachedAgentTabId: () => string | null;
  onRequestAgentAttachment: () => Promise<boolean>;
}

interface FrameRequest {
  channel: "pragma-scratchpad";
  token: string;
  type: "request";
  id: string;
  method:
    | "promptAgent"
    | "requestAgentAttachment"
    | "subscribeAgentProgress"
    | "unsubscribeAgentProgress";
  text?: string;
  tabIds?: string[];
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
  const subscriptionsRef = useRef(new Map<string, string[]>());
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);
  const [height, setHeight] = useState(96);
  const workspace = useWorkspace();
  const statuses = useAgentStatusSnapshot();
  const getAttachedRef = useRef(getAttachedAgentTabId);
  getAttachedRef.current = getAttachedAgentTabId;

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

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (isFrameRenderError(event.data, tokenRef.current)) {
        setError(event.data.message);
        return;
      }
      if (isFrameResize(event.data, tokenRef.current)) {
        setHeight(Math.max(64, Math.min(event.data.height, 4096)));
        return;
      }
      if (!isFrameRequest(event.data, tokenRef.current)) return;
      const request = event.data;
      if (request.method === "unsubscribeAgentProgress") {
        subscriptionsRef.current.delete(request.id);
        return;
      }
      if (request.method === "subscribeAgentProgress") {
        subscriptionsRef.current.set(request.id, request.tabIds ?? []);
        postProgress(request.id, request.tabIds ?? []);
        return;
      }
      void handleRequest(request);
    };
    globalThis.addEventListener("message", receive);
    return () => globalThis.removeEventListener("message", receive);
  });

  useEffect(() => {
    for (const [id, tabIds] of subscriptionsRef.current) postProgress(id, tabIds);
    // Current render owns latest status/tab snapshot; callback identity is intentionally excluded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, workspace.tabs]);

  useEffect(() => {
    subscriptionsRef.current.clear();
  }, [srcDoc]);

  // Theme edits and color-scheme switches restyle a live frame in place; a
  // rebuild would discard the component state the scratchpad is holding.
  useEffect(() => {
    const publish = (): void => {
      const theme = scratchpadTheme();
      post({ type: "theme", mode: theme.mode, css: theme.css });
    };
    globalThis.addEventListener(THEME_CHANGED_EVENT, publish);
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => {
      globalThis.removeEventListener(THEME_CHANGED_EVENT, publish);
      observer.disconnect();
    };
    // `post` closes over a ref, so it is stable across renders by construction.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = (message: object): void => {
    iframeRef.current?.contentWindow?.postMessage(
      { channel: "pragma-scratchpad", token: tokenRef.current, ...message },
      "*",
    );
  };

  const progressFor = (tabIds: readonly string[]): ScratchpadAgentProgress[] => {
    const requested = new Set(tabIds);
    return workspace.tabs
      .filter((tab) => requested.has(tab.id) && tab.worktreeId === worktreeId && tab.agentId)
      .map((tab) => {
        const live = statuses.find(
          (status) => status.worktreeId === worktreeId && status.tabId === tab.id,
        );
        return {
          tabId: tab.id,
          title: tab.title ?? undefined,
          agent: live?.agent ?? tab.agentId ?? undefined,
          status: live?.status ?? "cleared",
        };
      });
  };

  const postProgress = (id: string, tabIds: readonly string[]): void => {
    post({ type: "progress", id, entries: progressFor(tabIds) });
  };

  const handleRequest = async (request: FrameRequest): Promise<void> => {
    try {
      if (request.method === "requestAgentAttachment") {
        const attached = await onRequestAgentAttachment();
        post({ type: "response", id: request.id, value: attached });
        return;
      }
      const tabId = getAttachedRef.current();
      const attachedExists = workspace.tabs.some(
        (tab) => tab.id === tabId && tab.worktreeId === worktreeId && tab.agentId,
      );
      if (!tabId || !attachedExists) {
        post({ type: "response", id: request.id, value: "missing-agent" });
        return;
      }
      await scratchpadPromptAgent(worktreeId, tabId, request.text ?? "");
      post({ type: "response", id: request.id, value: "sent" });
    } catch (cause) {
      post({
        type: "response",
        id: request.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

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

function isFrameRequest(value: unknown, token: string): value is FrameRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.channel === "pragma-scratchpad" &&
    message.token === token &&
    message.type === "request" &&
    typeof message.id === "string" &&
    (message.method === "promptAgent" ||
      message.method === "requestAgentAttachment" ||
      message.method === "subscribeAgentProgress" ||
      message.method === "unsubscribeAgentProgress")
  );
}

function isFrameRenderError(
  value: unknown,
  token: string,
): value is { token: string; type: "render-error"; message: string } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.token === token &&
    message.type === "render-error" &&
    typeof message.message === "string"
  );
}

function isFrameResize(
  value: unknown,
  token: string,
): value is { token: string; type: "resize"; height: number } {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.token === token && message.type === "resize" && typeof message.height === "number";
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
