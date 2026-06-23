# Creating a Pragma agent plugin

This guide walks you through adding a new agent integration to Pragma — a plugin that
makes a third-party AI coding tool (like opencode or Claude Code) report its live status
back into the Pragma UI as it runs, finishes, or waits for input.

It is written for whoever (human or agent) is wiring up the next tool. Read it top to
bottom **before** writing code. Two companion references go deeper on the two routes a
plugin can take:

- **[SDK.md](./SDK.md)** — the preferred route: `@pragma/sdk`, a typed TS/JS wrapper.
- **[CLI.md](./CLI.md)** — the fallback route: the raw `pragma-agent` CLI for tools with
  no in-process JS plugin API.

Two real plugins exist; copy the one whose route matches your tool:

- `packages/opencode-plugin/` — **SDK route** (opencode has a JS plugin API).
- `packages/claude-code-plugin/` — **CLI route** (Claude Code only exposes shell hooks).

> **Plugins stay out of core.** A plugin package is self-contained data plus its own
> bundled assets. It must **not** add or modify code in Pragma core (`apps/pragma`,
> `src-tauri`), the daemon, the CLI, or the SDK without explicit owner permission. A
> plugin installs itself through its **host tool's own plugin mechanism**, never through
> per-plugin Pragma code. If you think you need new core behavior, **stop and ask first**.

---

## What a plugin actually does

Every plugin does exactly one thing: it translates its host tool's lifecycle into four
Pragma status reports, scoped to the current terminal tab.

| Report      | Dot    | Meaning                                  | Emit when…                                       |
| ----------- | ------ | ---------------------------------------- | ------------------------------------------------ |
| `started`   | yellow | Agent is running                         | a turn/tool/command begins                       |
| `stopped`   | green  | Finished — go look at the output         | a turn completes **normally**                    |
| `attention` | red    | Needs input / permission                 | a prompt, question, or permission dialog appears |
| `cleared`   | —      | Remove the indicator entirely            | the agent exits, crashes, or a turn is aborted   |

`cleared` is **not** `stopped`. `stopped` is the green "done, go look" signal and must
only ever follow a `started`. `cleared` removes the dot because there is nothing to look
at (quit / crash / abort). Conflating the two produces phantom "done" dots — the single
most common bug in these plugins.

The status reports reach the daemon through the `pragma-agent` CLI (directly, or via the
SDK which shells out to it). The CLI reads three env vars that the Pragma terminal
injects — `PRAGMA_DAEMON_SOCKET`, `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID` — connects to
the daemon socket, writes one `AgentReport` frame, and exits.

---

## Step 1 — Research the tool you're integrating

Do this **first**, before writing a line of code. A plugin is only as correct as your
understanding of the host tool's event model. For each tool, find out:

1. **Does it have an in-process JS/TS plugin API?**
   - **Yes** → use the **SDK route** (see Step 2A). This is strongly preferred.
   - **No, but it has shell-command hooks** → use the **CLI route** (see Step 2B).
   - **Neither** → stop; there is no integration point. Ask the owner.

2. **What lifecycle events does it actually emit?** Do not trust the documented event
   union — **verify empirically** by driving a real session and logging every event.
   Both existing plugins carry hard-won notes about events that the docs declare but the
   runtime never fires (and vice versa). Map each real event to one of the four reports.

3. **How does it signal a turn finished normally?** This becomes `stopped`.

4. **How does it signal "waiting for the user"** — a permission prompt, a question, an
   MCP elicitation? This becomes `attention`. Prefer the **earliest, most precise**
   signal (the instant the dialog shows), not a debounced desktop notification.

5. **What happens when the user cancels/aborts a turn?** This is the hard part. Find out
   whether any event fires at all. If the tool fires **nothing** on cancel (Claude Code
   does not), you must detect the abort another way — see "Required functionality →
   Abort handling" below.

6. **How is a plugin installed and loaded** in that tool? You will document this; Pragma
   does not install it for you.

Write down what you learn — surprising findings belong in your plugin's `AGENTS.md` so
the next person doesn't rediscover them the hard way.

---

## Step 2 — Choose your route

### Preferred: SDK route (TS/JS, for tools with a JS plugin API)

If the tool can load a JS/TS plugin in-process, write one and report status through
**`@pragma/sdk`**. This is the preferred route whenever it's possible because:

- You react to **structured, typed events** instead of parsing stdin or scraping
  transcripts.
- `@pragma/sdk` gives you typed `reportStarted` / `reportStopped` / `reportAttention` /
  `reportCleared` helpers — **never hand-build `pragma-agent` argv**.
- You get a real `dispose`/shutdown hook, so cleanup (`cleared`) is reliable.

See **[SDK.md](./SDK.md)** for the full API. Model your package on
`packages/opencode-plugin/`:

- `src/index.ts` — the plugin entry point. Builds a reporter from the SDK helpers, fires
  one `cleared` on load (see Required functionality), and returns the hooks.
- `src/hooks.ts` — a **state machine** that derives the reported status from a small set
  of flags and emits **only on change**. Do not map one event → one report blindly; a
  trailing stream event will clobber green back to yellow. Derive
  `attention > busy > idle` and dedupe.
- `package.json` — built with Bunup to a single ESM file, depends on `@pragma/sdk`
  (`workspace:*`).

### Fallback: CLI route (shell hooks, for tools with no JS API)

If the tool's only extension point is shell-command hooks, write a real plugin for that
tool where every hook shells out to a single bundled script that calls `pragma-agent`
directly. See **[CLI.md](./CLI.md)** for the CLI contract. Model your package on
`packages/claude-code-plugin/`:

- A host-tool plugin manifest + hooks file that map each lifecycle hook to
  `sh "$PLUGIN_ROOT/hooks/report.sh" <event>`.
- One `report.sh` that translates events → `pragma-agent report …`. Keeping the logic in
  one script (not inline JSON one-liners) is what makes it testable.
- Tests that drive `report.sh` with a fake `pragma-agent` on `PATH`.

Keep all logic in the shell script and keep it **POSIX `sh`**, invoked via `sh` so it
works regardless of the executable bit.

---

## Required functionality

Every plugin, regardless of route, **must** implement all of the following:

1. **Report all four statuses correctly.** `started`, `stopped`, `attention`, `cleared`,
   mapped from real (verified) tool events. Respect the `stopped` vs `cleared`
   distinction above.

2. **Guard on the Pragma environment.** The plugin must be a **silent no-op** outside a
   Pragma terminal — it will run in every session of the host tool, including ones the
   user starts on their own. Check that `PRAGMA_DAEMON_SOCKET` (and ideally
   `PRAGMA_TAB_ID`, `PRAGMA_WORKTREE_ID`) are set before reporting. The SDK guards on
   these for you; the CLI script must check explicitly (`[ -n "$PRAGMA_DAEMON_SOCKET" ]
   || exit 0`).

3. **Never disrupt the host session.** A missing `pragma-agent`, a down daemon, or any
   reporting error must never break the user's tool. The SDK swallows errors (optionally
   logging in debug mode); the CLI script wraps every call `… >/dev/null 2>&1 || true`.

4. **Clear a stale indicator on load.** Fire one `cleared` when the plugin starts up. A
   previous run in the same tab may have crashed without cleanup, leaving a stale dot in
   the long-lived daemon; clearing up front guarantees a fresh session never inherits it.
   Genuine activity immediately re-raises the right status.

5. **Clear on exit.** When the agent process quits (graceful dispose **and**, if
   observable, abrupt shutdown), report `cleared` — not `stopped`.

6. **Handle aborted turns.** When the user cancels a turn (ESC, declining a prompt,
   rejecting a question), the result is `cleared`, not `stopped`. If the tool emits an
   event for this (opencode surfaces a `session.error` carrying an abort error), map it.
   **If the tool fires no event at all** (Claude Code), you must detect the abort some
   other way — the Claude Code plugin spawns a detached background watcher that polls the
   session transcript for the interrupt marker and reports `cleared` when it appears.
   Whatever the mechanism, an aborted turn must never leave the tab stuck on
   yellow/red, and must never produce a phantom green "done".

7. **Ship an agent launcher config** so the tool appears in Pragma's launcher (next
   section).

8. **Add an `AGENTS.md`** to your package documenting the event→status mapping, the
   install command, and every non-obvious gotcha you discovered in Step 1.

9. **Add tests.** SDK route: Vitest against the hooks state machine. CLI route: Vitest
   (or a shell harness) driving `report.sh` with a fake `pragma-agent`.

---

## The agent launcher config

So the tool shows up as a launchable agent in Pragma, ship a bundled config at:

```
packages/<your>-plugin/pragma/agents/<agent-id>/config.json
packages/<your>-plugin/pragma/agents/<agent-id>/icon.svg
```

`config.json` fields (see the two existing examples):

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "icon": "icon.svg",
  "start": ["claude", "--permission-mode", "auto"]
}
```

- `id` — stable agent id; this is the `--agent <id>` you pass to `pragma-agent`.
- `name` — display name in the launcher.
- `icon` — must resolve **inside** this agent directory.
- `start` — argv used to launch the tool in a Pragma terminal.

This is the **only** Pragma-side install. `apps/pragma/src-tauri/scripts/stage-daemon-sidecar.sh`
copies every plugin package's `pragma/agents/*` into the bundle's
`resources/pragma/agents`, and the app's generic `agents::ensure_bundled_installed`
installs those into `~/.pragma/agents` on startup. There are deliberately **no**
per-plugin core files. When you add a plugin, add the matching `cp -R …/pragma/agents/.`
line to that staging script (this is the one allowed core touch — the generic launcher
step) and update the repo `AGENTS.md` repository-structure table.

---

## Installation (through the host tool, not Pragma)

The plugin code itself installs through the **host tool's own plugin mechanism**. Your
`AGENTS.md` must document the exact command. Examples from the two existing plugins:

**opencode (SDK route)** — register the built `dist/index.mjs` absolute path (or a
`file://` URL) in the `plugin` array of `~/.config/opencode/opencode.json`. Never
register it by bare package name (opencode would try to npm-fetch it).

**Claude Code (CLI route)** — through Claude Code's marketplace:

```bash
claude plugin marketplace add <path-to-packages/claude-code-plugin>
claude plugin install <plugin-name>@<marketplace-name>
```

This installs at user scope so the plugin runs in every session — which is exactly why
the env guard (Required functionality #2) is mandatory.

---

## Checklist before you open a PR

- [ ] Researched and **empirically verified** the tool's real event model.
- [ ] Picked the SDK route unless the tool has no JS plugin API.
- [ ] All four statuses mapped; `stopped` only after `started`; `cleared` ≠ `stopped`.
- [ ] No-op outside a Pragma terminal (env guard).
- [ ] Reporting errors can never disrupt the host session.
- [ ] Fires `cleared` on load and on exit.
- [ ] Aborted turns reliably resolve to `cleared`.
- [ ] `pragma/agents/<id>/config.json` + icon shipped, and staging script updated.
- [ ] `AGENTS.md` written (mapping, install, gotchas).
- [ ] Tests added; `bun run check` passes.
- [ ] Updated the repo-root `AGENTS.md` structure table.
- [ ] Did **not** modify Pragma core/daemon/CLI/SDK (beyond the generic staging line).
