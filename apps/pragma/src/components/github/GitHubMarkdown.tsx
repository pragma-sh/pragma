import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
