import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { browserOpenExternal } from "@/lib/tauri";

/**
 * Custom renderers. The default `<a>` navigation would load the page inside the
 * app webview; hand any real URL to the system browser instead. Defined at module
 * scope so it isn't recreated on every render (and avoids the nested-component lint).
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        if (href) {
          event.preventDefault();
          void browserOpenExternal(href);
        }
      }}
    >
      {children}
    </a>
  ),
};

/**
 * Renders GitHub-flavored markdown (PR bodies, comments) read-only. Links open
 * externally via the browser-open command rather than navigating the webview.
 * Styling rides on the Tailwind `prose` classes already used across the app.
 */
export function GitHubMarkdown({ children }: { children: string }) {
  if (!children.trim()) {
    return <p className="text-xs italic text-slate-500">No description provided.</p>;
  }
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words text-slate-200">
      <ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
