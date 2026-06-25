import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
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
 *
 * Inline HTML (which GitHub comments routinely contain) is parsed via
 * `rehype-raw` and then run through `rehype-sanitize` so embedded scripts,
 * `javascript:` URLs, and event handlers are stripped before render — the raw
 * HTML displays, but no untrusted JavaScript executes.
 *
 * Long content (code fences, wide tables, unbroken URLs) wraps or scrolls
 * **within** its own block rather than forcing the whole comment to scroll
 * sideways: `pre` wraps and `code`/words break, while tables scroll locally.
 */
export function GitHubMarkdown({ children }: { children: string }) {
  if (!children.trim()) {
    return <p className="text-xs italic text-slate-500">No description provided.</p>;
  }
  return (
    <div className="prose prose-invert prose-sm max-w-none overflow-hidden break-words text-slate-200 [&_code]:break-words [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_table]:block [&_table]:overflow-x-auto">
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
