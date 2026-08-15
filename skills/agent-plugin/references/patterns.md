# Hard Agent Plugin Patterns

## Claude Code Abort Detection

Claude Code emits no hook for ESC mid-response, prompt rejection, or question decline.
Current plugin uses transcript evidence:

1. On `UserPromptSubmit`, save transcript byte size and unique turn token.
2. Kill prior per-tab watcher, write token marker, spawn detached `nohup sh` watcher.
3. Poll only bytes after saved offset for unescaped JSON text
   `"text":"[Request interrupted by user`.
4. Before clearing, re-read marker and require same token.
5. Normal `Stop`, session end, and next turn remove marker and stop watcher.
6. Apply absolute lifetime backstop so SIGKILL cannot orphan process forever.

Do not grep bare phrase or whole transcript tail. Tool output can mention phrase, and old
cancel markers remain in transcript. Read `packages/claude-code-plugin/hooks/report.sh`
and its tests before changing this mechanism.

## Sub-Agent Tracking

SDK route: classify child sessions from parent id, retain classification across partial
updates, keep set of active children, and derive parent busy as parent work OR active
children. Emit `subAgentsActive` on rich messages.

CLI route: use per-tab child marker directory keyed by child id. Parent `Stop` remains
started while any child marker or host-provided running subagent remains. Parent's final
stop owns done report. Do not count unrelated long-lived background shell tasks.

Verification requires concurrent count reaching at least two when host supports it and
forbids done while active count is nonzero.

## Watcher Decisions

Use `createTuiWatcher({ agent, handleDecisions: true })` only when no blocking host hook
can return verdict. Watcher connection is already scoped to agent/tab. Cache attention
metadata by request id, dedupe replayed decisions/answers, reconnect dropped streams, and
swallow failed `sendKeys` writes.

Approval keys depend on tested TUI layout. OpenCode currently approves with Enter and
rejects with two Right arrows then Enter. Question answers select listed rows by digit;
free text selects custom-answer row, types text, then submits. Dismiss sends Escape.

Free-text delivery uses the TUI's native custom-answer editor. Multi-question replies
select or type each answer into its corresponding prompt in order. Never abort a turn and
inject a synthetic follow-up chat message as an answer fallback.

When blocking hooks handle commands, set `handleDecisions: false`; this avoids duplicate
verdict keystrokes racing hook return. Add `handleQuestionAnswers: true` only when questions
have a separate reporting signal but require TUI delivery. Answers without matching cached
question attention must be ignored so wrong/stale request ids cannot dismiss a live prompt.

## Usage Limits

Claude Code provider sends supported structured `get_usage` control request through
short-lived `claude -p`. Normalize utilization to percentage limits, preserve reset
times relative to `observedAt`, return authentication-required when account lacks plan
data, and throw malformed/transport failures.

Cursor provider executes plugin-owned helper that reuses `cursor-agent login`
credentials. Return not-configured when helper is absent, authentication-required for
missing login, unsupported for valid responses without expected categories, and throw
execution/parser failures.

Provider result contract:

```ts
type UsageLimitsResult =
  | { status: "ready"; observedAt: number; summary?: UsageLimit; limits: UsageLimit[] }
  | {
      status: "unavailable";
      reason: "not-configured" | "authentication-required" | "unsupported";
      message: string;
    };
```

Each `UsageLimit` has stable `id`, title, finite nonnegative `used`, finite positive or
null `limit`, and optional nonnegative `resetsInMs`.
