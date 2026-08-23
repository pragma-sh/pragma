# Pragma Agent Plugin Reference

An **agent plugin** integrates a host coding-agent tool — OpenCode, Claude Code, Cursor,
Codex, or a new TUI agent — so it reports live status into Pragma and appears in the
agent launcher. Use this reference for lifecycle reporters, launchable agents, PTY
watchers, and account usage-limit providers.

For sidebar tabs, cards, web views, commands, keybindings, settings, or CSS, use
`plugin-api.md` instead. Derive the reporting contract from this file only; `plugin-api.md`
covers the general plugin API and does not define status semantics.

Companion references:

- `plugin-api.md`: `definePlugin` contributions, plugin context, hooks, bundling rules.
- `sdk.md`: typed `@pragma/sdk` client and reporting helpers.
- `cli.md`: general `pragma-cli` surface.
- `agent-plugin-cli.md`: exact agent CLI commands and flags.
- `agent-plugin-patterns.md`: abort, sub-agent, watcher, and usage-limit patterns.

## Choose Route First

1. Research host's real extension points and lifecycle. Verify behavior with a real
   session; documented event unions can differ from runtime.
2. If host loads an in-process JavaScript/TypeScript plugin, use SDK route. Model
   `packages/opencode-plugin/src/index.ts` and `hooks.ts`.
3. Otherwise, if host offers blocking or notification shell hooks, use CLI route.
   Model `packages/claude-code-plugin` or `packages/cursor-plugin`.
4. Otherwise, contribute a `createTuiWatcher` through Pragma plugin. Parse
   `ctx.output`, derive state from rendered TUI, and use `sendKeys` for replies.
   Set `handleDecisions: true`. Document parsing fragility and exact tested version.
5. If host has account usage for its default provider, also add a
   `defineUsageLimitProvider`.

Do not add host-specific installers or parsing to Pragma core. Plugin packages install
through host tool's own mechanism. Ask owner before changing core, server, CLI, SDK, or
UI for one plugin. Generic plugin infrastructure and `agent verify` are exceptions only
when work is explicitly approved.

## Use TypeScript Or Shell Only

Write all plugin scripts, helpers, parsers, generators, migrations, and test harnesses
in TypeScript. Use Bun to run them. Use POSIX `sh` only when a host integration requires
a shell hook or a minimal shell wrapper. Never introduce Python, Ruby, Perl, Lua, or any
other scripting language, including for one-off development or verification scripts.
If TypeScript can perform the task, do not use `sh`.

## Preserve Status Invariants

Translate verified host lifecycle into four reports:

| Report      | Runtime status | Emit when                                    |
| ----------- | -------------- | -------------------------------------------- |
| `started`   | `running`      | turn, command, tool, or child work starts    |
| `stopped`   | `done`         | a started turn finishes normally             |
| `attention` | `attention`    | question or command approval becomes visible |
| `cleared`   | removed        | load reset, process exit/crash, or abort     |

Also report the session's display name with `session-name` (SDK
`reportSessionName({ agent, env, name })`, CLI
`pragma-cli agent report --agent <id> session-name --name "<name>"`). It is
status-less: Pragma renames the hosting tab to it unless the user renamed the tab
manually. Report it on session create, on every rename, and on every session
switch. If the host exposes no session title, derive one from the first user
prompt per session (first line, ~48 chars), or declare `sessionName` in
`excludeFeatures`. `agent verify` runs a `session-name` scenario unless excluded.

Enforce both rules:

- Emit `stopped` only after `started`. Bare idle must not create a phantom done dot.
- Abort, rejected/cancelled prompt, crash, and process exit emit `cleared`, never
  `stopped`.

Guard reporting outside Pragma. SDK route uses `hasPragmaEnvironment`; CLI route starts
with:

```sh
[ -n "${PRAGMA_SERVER_SOCKET:-}${PRAGMA_DAEMON_SOCKET:-}" ] || exit 0
```

Never disrupt host. Catch SDK reporting failures; wrap CLI calls with
`>/dev/null 2>&1 || true`. Emit one `cleared` on plugin/session load and another on
observable process exit.

## SDK Route

Build reporter like `packages/opencode-plugin/src/index.ts`:

- Resolve stable `agent` id once.
- Guard environment before calling SDK.
- Catch every report failure; optional debug logging only.
- Use `reportStarted`, `reportStopped`, `reportAttention`, `reportCleared`,
  `reportSessionName`, and `reportMessage` instead of constructing transport payloads.
- Keep message ids stable while streaming updates. `ts` is Unix milliseconds, not
  seconds. Preserve non-decreasing timestamps per id.
- Carry `requestId` from attention through decision/answer round-trips.

Use a derived state machine, not direct event-to-report mapping. Model OpenCode's
`busy` + `attention` flags: `attention > busy > idle`, emit only changes, and serialize
reports through one promise queue. Track child sessions independently so parent idle
cannot report done while children remain active. Map `MessageAbortedError` to clear.

## CLI Route

Keep host hook translation in one POSIX `sh` file invoked with `sh`, then test it with a
fake `pragma-cli` on `PATH`.

Map hook manifest events to that script. For command approval:

1. Report `attention --kind command --command ... --request-id ...`.
2. Block with `await-decision` using a finite timeout.
3. Return host's allow/deny JSON.
4. On timeout, emit nothing and let native prompt handle it.

For one question, report `attention --kind question --question ... --options ...
--request-id ...`, block with `await-answer`, and translate answer/dismissal into host's
hook result. Fall back to native UI when payload cannot be represented faithfully.

After any verdict or answer resolves the block, **re-assert `started` before returning
the decision** (guarded on the turn being in flight). A denied tool never runs, so no
post-tool hook follows — without the re-assert the tab stays stuck on attention until
the turn ends. If session start/end hooks race a new session's first turn (e.g. Claude
Code `/clear`), guard the clear on which session owns the in-flight turn, or the late
clear mutes every turn-guarded report (see `packages/claude-code-plugin/AGENTS.md`).

If host emits no abort hook, use an empirically verified secondary signal. Claude Code
watches transcript bytes after current turn's starting offset; do not grep entire tail,
because stale interrupt markers clear later turns. See `agent-plugin-patterns.md`.

Stream assistant replies during the turn, not only at stop. Chat consumers (mobile)
render raw Markdown as it arrives; a reply that first appears after the done report reads
as a dead session while the agent works. When the host records completed assistant
messages in a transcript (Codex rollout `agent_message` lines), sync them from the same
turn-scoped watcher with stable per-turn ids and a sent-count dedupe, and perform one
final sync before reporting `stopped` so the reply event precedes done. Keep the
stop-payload reply only as a fallback when no transcript is available.

## Pragma Plugin Side

Contribute launcher with `defineAgent`:

- `id`: stable local id. Reporters (`--agent`/SDK) must use exactly this LOCAL id (the
  final segment of the resolved catalog id, e.g. `codex`, never `pragma.codex`): chat
  consumers and `agent verify` filter the event stream by it, so a qualified id makes
  every report invisible to mobile.
- `launch.command`: argv array; never shell-join it.
- `models`: static entries or async `(ctx) => Promise<entries>` provider.
- `args.model`, `args.reasoning`, optional `args.modelReasoning`, and
  `args.permissionMode`: return argv fragments.
- `startupInput`: timed pre-TUI gates.
- `prefillDelayMs`, `prefillMode`, `prefillSubmit`, `prefillSubmitDelayMs`: agent-owned
  prompt delivery behavior.
- `excludeFeatures`: declare unsupported optional capabilities (`questions`,
  `commandApproval`, `commands`, `subagents`, `abort`, `interrupt`, `usageLimits`,
  `sessionName`) so `agent verify` skips scenarios the host cannot implement.

Model discovery rules:

- Never emit a provider-level Auto model in static `models` or provider output. When a
  selected model has `reasoning` entries, Pragma shows an Auto reasoning choice for
  model-only launch, which appends `args.model` and no reasoning arguments.
- Provider entries are `{ id, name, reasoning?: [{ id, name }] }`. Omit `reasoning` when
  the host has none or cannot expose levels reliably for that model.
- Emit fast variants as separate model entries. Never collapse them into a fast toggle.
- Discovery is lazy: Pragma calls the provider when the selector submenu is focused,
  shows cached results immediately, then updates with the refreshed result.
- Keep host-specific model parsing inside the plugin provider and prefer supported host
  CLI/API model-list surfaces over private databases or internal caches. Core must never
  learn a host's model output format.

Attach `createTuiWatcher`:

Use `@pragma/watcher-kit` for basic agent prompting operations: interjections, command
decisions, question answers, and prompt submit timing. Do not reimplement its connection,
replay, request-id dedupe, or TUI-key logic in each extension. Inside the Pragma monorepo,
install it in the extension package as `"@pragma/watcher-kit": "workspace:*"`; external
plugins install the published package normally.

- `handleDecisions: true` when host lacks a decision-returning hook (OpenCode).
- `handleDecisions: false` when blocking hooks return decisions (Claude Code, Cursor).
- Add `handleQuestionAnswers: true` when command approvals use blocking hooks but
  questions must be answered through TUI keys (Codex). Never handle unmatched request ids.
- Question replies must use the host's native TUI controls. Listed answers select
  their matching row; free-text answers open the native custom-answer editor; batches
  answer each prompt in order. Never abort a response and inject the answer as a
  synthetic follow-up chat message.
- Set `questionSelectMode: "arrow-space"` when the question list does not bind digit
  shortcuts and instead navigates with Down, marks with Space, and submits with Enter
  (Junie). Keep the default `"digit"` for TUIs whose rows are select-and-submit digits
  (OpenCode, Codex). Verify the real keymap against a live prompt; a wrong mode fails
  only as a question timeout.
- Use watcher for interjections when host has no mid-turn input hook.

Add `defineUsageLimitProvider` when applicable. Return either `ready` with finite,
well-formed `limits`, or `unavailable` with a supported reason and useful message. Throw
for unexpected transport/parser failures so verification detects regressions. See real
Claude Code and Cursor implementations in `agent-plugin-patterns.md`.

## Find Official Branding Icon

Use first-party branding, not an invented mark or generic terminal icon:

1. Search official product website, documentation, press/brand kit, or vendor-owned
   source repository. Prefer a downloadable logo asset explicitly published by vendor.
2. Confirm source is vendor-controlled and icon represents coding agent product, not
   parent company or unrelated app. Record source URL and retrieval date in plugin
   `AGENTS.md` so future maintainers can refresh it.
3. Check stated trademark/brand and asset license terms. Do not copy third-party icon
   aggregators when official source exists. If redistribution terms are unclear, ask
   owner before committing asset.
4. Prefer SVG for crisp launcher rendering. Download original bytes; do not trace a PNG,
   screenshot website, scrape browser favicon, or redraw logo. Keep vendor colors unless
   official kit provides monochrome variant.
5. Inspect SVG before committing: remove scripts, event handlers, remote references,
   embedded raster data, metadata containing personal paths, and unnecessary editor
   payload. Preserve `viewBox` and visual geometry. Never run untrusted SVG as HTML.
6. Store asset in plugin's `assets/` directory with descriptive kebab-case name. Point
   `defineAgent.iconPath` and usage provider `iconPath` at same canonical file when they
   represent same product.
7. Build plugin and fetch catalog icon through `/v1/assets/{hash}` (or run `agent verify`
   catalog gate) to confirm MIME, hash, size cap, and rendering. Check both light and dark
   backgrounds; use official alternate variant when primary mark loses contrast.

When no official downloadable asset exists, document search locations and ask owner to
choose between vendor favicon, text mark, or temporary generic icon. Do not silently
approximate brand.

## Bundle And Register

Set package metadata:

```json
{
  "pragma": {
    "pluginId": "vendor.agent",
    "main": "./dist/pragma-plugin.mjs"
  }
}
```

Build agent-side TypeScript and Pragma-side bundle with Bunup. Keep icons and helpers in
plugin package. **The Pragma-side `dist/pragma-plugin.mjs` must stay browser-safe:** the
desktop webview loads it through a blob-URL `import()`, so a bare `node:fs` / `node:os`
/ `node:path` import fails the whole plugin with "Importing a module script failed".
A module-scope `process.platform` / `process.env` read fails the same way. Symptom is
one-sided and easy to misread: the Bun sidecars load the same bundle fine, so
`/v1/agents/catalog` still lists the agent while it is **missing from the launcher** and
Settings → Plugins shows the entry as failed. Keep node-only work lazy
(`globalThis.process?.…`, `await import("node:…")` inside the function). For bundled
plugins `stage-bundled-plugins.sh` enforces this at build time.
Host I/O (caches, credential probes, model lists) goes through `ctx.sdk.exec.run` so it
also hits the correct machine for a remote project. Register development bundle through
project/global `.pragma/config.json` `plugins[]`. Install runtime reporting through
host's own mechanism:

- OpenCode: absolute built `dist/index.mjs` path (or a `file://` URL) in the `plugin`
  array of `~/.config/opencode/opencode.json`. Never register by bare package name —
  OpenCode would try to npm-fetch it.
- Claude Code: marketplace add/install.
- Cursor: package's `install-local.sh` hook merger.

## Mandatory Verify Loop

Run real integration harness from target worktree:

```sh
pragma-cli agent verify --agent <catalog-id> --abort-input '\x1b'
```

Verify launches sessions headlessly by default (payload `headless: true`), so the server
builds commands from the live sidecar catalog and no desktop tab opens per scenario even
while the app is running. Still reload or restart Pragma after rebuilding a plugin bundle
so pragma-server's catalog reflects the new command and watcher. Pass `--headed` only when
you specifically need to exercise the desktop launch broker (a running app brokers headed
launches through its own plugin copy and can silently drop new launch flags even when the
gateway catalog is fresh). Host hook trust is separate: script-body edits do not require
re-trust unless the trusted hook definition itself changed.

Scenarios run concurrently on a worker pool (`--jobs`, default 6; `stream-integrity`
always runs alone afterwards). Use `--jobs 1` to serialize when debugging cross-talk or a
host that cannot run parallel sessions in one worktree. Parallel cold starts slow TUI
boot; two guards cover the resulting lost-prefill window: the headless launcher waits
for the TUI's alternate screen before typing the prompt, and `await_running` retypes
the prompt once after a short first window (half `--step-timeout`, capped at 20s) before
failing an attempt. A headless launch also probes the terminal immediately, so a server
or session error fails the attempt before any event timeout. `--step-timeout` is one total
budget shared by every wait within a fresh-session attempt. Retries receive a fresh budget
instead of inheriting an expired deadline.
Event waits fail fast on settle: an agent that finishes its turn
without the awaited attention/message/sub-agent report fails ~10s after done/cleared
(`agent settled without ...`) instead of waiting out the full step timeout. Use `--scenario <id>` while
iterating, `--prompts <file.json>` for host-specific prompt tuning, and `--include-slow`
before final handoff. Re-run until every applicable scenario passes. Skips need explicit
capability reasons; failures are not handoff-ready.

The verifier explicitly clears status for every session it launched before exiting,
including failed attempts, so a timeout must not leave stale running/attention dots.

Verification burns real LLM tokens. Pick the **cheapest available model that can still
spawn sub-agents** (the `subagent` scenario requires sub-agent capability) instead of the
catalog default. When that model is not in the plugin's catalog model list, pass its raw
launch flags with `--pick-model-cmd`:

```sh
pragma-cli agent verify --agent <catalog-id> --pick-model-cmd "--model moonshot/kimi-k3"
```

`--pick-model-cmd` appends the snippet to the agent's base launch command and overrides
`--model`; check the host's own model list (for example `opencode models`) for the
cheapest subagent-capable id before running the full suite.

`question-free-text` requires the agent to echo the exact marker returned through the
native custom-answer editor in the same turn.

Question attention can reach the event stream immediately before a host mounts its TUI
prompt. Keep a short prompt-mount delay before watcher answer keys and verifier abort
input; otherwise parallel cold starts make both paths intermittently lose input.

Also run package tests and `bun run check`. For hook packages, refresh installed copy and
restart host before live run.

## Checklist

- Real host events and abort behavior recorded in package `AGENTS.md`.
- All four statuses empirically verified; stopped-after-started invariant holds.
- Outside-Pragma guard and fail-open reporting present.
- Stale state clears on load and exit.
- Reporter id, watcher id, and resolved catalog id match.
- Official icon provenance/license documented; asset sanitized and contrast-checked.
- Sub-agent work cannot produce premature done.
- Question/decision request ids round-trip.
- Usage-limit provider included when host exposes account limits.
- Every script uses TypeScript, except necessary POSIX `sh` hooks or wrappers.
- Unsupported optional capabilities are listed in `excludeFeatures`; skipped verifier
  scenarios carry that explicit reason.
- `agent verify` applicable scenarios all pass, including abort and stream integrity.
- Package tests and `bun run check` pass.
- Relevant `AGENTS.md` updated with new workflow or gotcha.
