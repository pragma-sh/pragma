# Scratchpads

A scratchpad is an agent-authored MDX document Pragma renders as a real, interactive tab: React components, live agent bindings, user-editable prose, inline comments. It is the rich-output channel for an agent that would otherwise dump ASCII or walls of text into a terminal.

## When To Suggest One

Suggest (or just create) a scratchpad when the answer is more than linear text:

- **Plan / design / architecture writeup** the user will read, edit, and comment on.
- **Complex comparison, matrix, table, checklist, chart** — anything with structure.
- **Long-running multi-tab work** — use `AgentProgress` for live status.
- **Anything the user will keep and revisit.** Terminal scrollback is disposable; a scratchpad is a file with a tab.

Ask before creating only when the user is mid-flow on something else; otherwise create it and say where it is available in the scratchpad sidebar card.

## Create It

Only through the CLI. Never write into `.pragma/scratchpads/` by hand — the desktop rejects any file lacking command-generated frontmatter.

```sh
pragma-cli scratchpad create --title "Auth rewrite plan" plan.mdx
# or from stdin
pragma-cli scratchpad create --title "Auth rewrite plan" -
```

The file argument must end in `.mdx` (or be `-`). The command copies source into `.pragma/scratchpads/<slug>-<id8>.mdx`, adds `.pragma/scratchpads/` to the repo's local git excludes, stamps managed frontmatter (version, id, title, creating agent tab from `PRAGMA_TAB_ID`, `createdAt`), opens a scratchpad tab, and prints the created path.

Requires Pragma terminal environment (`PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`, `PRAGMA_SERVER_SOCKET`). Creator must be a terminal tab in the current worktree.

The attached agent tab is what every interactive component talks back to — a user answer or diff decision arrives as input in _your_ terminal. Write the document expecting to be prompted later.

## Authoring MDX

The frame bundles the document at open time (esbuild-wasm, MDX + GFM). Rules:

- Markdown is markdown; GFM tables, task lists, footnotes work.
- Import components from `@pragma/scratchpad/ui`, primitives from `@pragma/scratchpad/ui/primitives`, host bindings from `@pragma/scratchpad`.
- `react`, `react/jsx-runtime`, `react-dom/client` are provided by the frame.
- Relative imports resolve against files in the worktree.
- Bare specifiers resolve to a worktree `node_modules` package if present, else fetch from `https://esm.sh/<pkg>?bundle`. Plain `https:` imports work; `http:`, `file:`, `node:`, and absolute paths are rejected.
- No Node APIs, no Tauri APIs, no `window.parent` — the frame is sandboxed.
- Styling comes from desktop theme variables (`var(--card)`, `var(--primary)`, `var(--radius-md)`). Prefer the shipped components over hand-rolled markup so the document follows the user's theme.
- Every imported component is wrapped in an error boundary, so one bad component does not blank the document.

## Component API

`@pragma/scratchpad/ui` — interactive, agent-bound:

```mdx
import { AskQuestion, DiffReview, AgentProgress } from "@pragma/scratchpad/ui";

<AskQuestion
  question="Which auth strategy?"
  type="options"
  options={[{ label: "Session cookies" }, { label: "JWT", value: "jwt" }]}
  allowOpenResponse
/>

<DiffReview file="src/auth.ts" before={oldText} after={newText} />

<AgentProgress tabIds={["tab-1", "tab-2"]} />
```

- `AskQuestion` — `question`, `type`: `"options" | "yes-no" | "multi-select" | "text"`(default `options`), `options[]` (`{ label, value? }`), `allowOpenResponse` (adds an "Other" choice with an inline text field), `submitLabel`, `onAnswer`. Choice shapes submit on the button, not on click. Answer is sent to the attached agent tab as `Answer to scratchpad question "...": <value>`.
- `DiffReview` — `title`, `before`, `after`, `file`, `onDecision(accepted)`. Renders a side-by-side merge view with word-level highlights; accept/reject is reported back.
- `AgentProgress` — `tabIds`, `title`. Live `running | attention | done | cleared` per tab, via the host bridge.

`@pragma/scratchpad/ui/primitives` — presentational, theme-matched: `Button` (`variant`: `primary | secondary | outline | ghost | danger`, `size`), `Input`, `Textarea`, `Progress` (`tone`), `Card`, `Badge` (`tone`: `neutral | primary | success | warning | danger`).

`@pragma/scratchpad` root — host bridge plus a re-export of `@pragma/sdk`:

```ts
import { promptAgent, scratchpadBridge } from "@pragma/scratchpad";

await promptAgent("User picked JWT; continue."); // → boolean
```

`promptAgent(text, { onMissingAgent })` sends to the attached agent tab. With no attachment, the host opens its picker by default; `onMissingAgent({ text, attach })`overrides that for one call. Returns `false` when the user cancels. Every interactive component accepts the same `onMissingAgent` prop.

## After Creation

The user can edit the prose, and can leave range comments (stored beside the file as `<file>.mdx.comments.json`). Re-read the scratchpad file before acting on it — the text you shipped may not be the text they kept.
