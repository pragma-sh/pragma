# Pragma Automations SDK Reference

`@pragma/automations` defines trusted host-side TypeScript/JavaScript tasks. Use automation
for scheduled jobs, lightweight event polling, and tasks user may also start with **Run now**.
Use plugin API when capability needs Pragma UI, commands, or launchable agents.

Installed TypeScript declarations remain authority for exact fields.

## File Locations

| Scope   | Directory                        | Behavior                                     |
| ------- | -------------------------------- | -------------------------------------------- |
| Global  | `~/.pragma/automations/`         | Available globally and treated as trusted.   |
| Project | `<project>/.pragma/automations/` | Shared with project; requires user approval. |

Use one `.ts` or `.js` file per automation. Project automations are project-scoped, not
duplicated per Git worktree. Pragma discovers changes automatically.

Automations execute arbitrary host code. Do not trust project automation without reviewing
source. Changed project source has new content identity and returns to approval flow.

Open **Settings > Automations** to inspect source, trust or reject pending project code,
save edits, see load errors, and choose **Run now**.

## Define Automation

Default-export result from `defineAutomation`:

```ts
import { defineAutomation } from "@pragma/automations";

export default defineAutomation({
  name: "Daily repository check",
  description: "Logs repository markers every weekday morning",
  trigger: { type: "cron", schedule: "0 9 * * 1-5" },
  async run(ctx) {
    const markers = await ctx.fs.find(".", { name: "package.json" });
    ctx.log.info("Repository check complete", { markers });
  },
});
```

Required fields:

- `name`: user-visible label.
- `description`: explain outcome and side effects.
- `trigger`: cron schedule or event listener.
- `run(ctx, payload)`: task body. May be async.

## Cron Triggers

```ts
trigger: { type: "cron", schedule: "*/15 * * * *" }
```

Schedule uses five-field cron form: minute, hour, day of month, month, day of week. Prefer
clear, low-frequency schedules. Automation may also run manually regardless of schedule.

## Event Triggers

Event trigger installs listener and calls `fire(payload)` when work should run:

```ts
trigger: {
  type: "event",
  listen(ctx, fire) {
    let previous = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      try {
        const exists = (await ctx.fs.find(".", { name: "ready.flag" })).length > 0;
        if (exists && !previous) fire({ path: "ready.flag" });
        previous = exists;
      } catch (error) {
        ctx.log.warn("Ready flag check failed", error);
      } finally {
        if (!stopped) timer = setTimeout(() => void check(), 5_000);
      }
    }

    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  },
},
async run(ctx, payload) {
  ctx.log.info("Ready flag appeared", payload);
}
```

Rules:

- Return cleanup function for timers, watchers, and subscriptions.
- Fire on transition, not every poll, unless repeated runs are intentional.
- Catch expected polling errors and log useful context.
- Keep concurrency and scan frequency bounded.
- Payload can be any in-process value but should stay small and serializable for clarity.

## Context

`run` and event `listen` receive `AutomationContext`:

| Member               | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `ctx.log.info`       | Structured informational log.                                  |
| `ctx.log.warn`       | Structured warning log.                                        |
| `ctx.log.error`      | Structured error log.                                          |
| `ctx.paths.project`  | Project root for project automation; automation root globally. |
| `ctx.paths.worktree` | Execution root exposed by current runtime.                     |
| `ctx.paths.global`   | `true` for global automation.                                  |
| `ctx.fs.find`        | Bounded recursive file search.                                 |

`ctx.fs.find(path, options?)` returns matching relative paths. Options:

- `name`: exact basename filter.
- `minBytes`: minimum file size.

Search skips generated directories such as `node_modules`, `.git`, `.pragma`, and `target`,
plus symlinks. `ctx.git` is currently reserved and exposes no methods; use supported context
only rather than assuming future Git API.

## Authoring Rules

- Make `description` state user-visible effect, especially writes or external calls.
- Resolve paths from `ctx.paths`; do not hard-code machine-specific absolute paths.
- Make repeated runs idempotent where possible. Cron jobs may run again after partial failure.
- Log start/result counts and actionable failures, not secrets or full sensitive payloads.
- Avoid unbounded timers, recursive scans, detached processes, and overlapping work.
- Review bare-package imports before trusting automation; dependencies execute host code too.
- Prefer plugin, SDK, or CLI when automation context lacks required capability. Do not reach
  into Pragma internals.

## Verify

1. Place file in intended automation directory.
2. Open **Settings > Automations** and inspect parsed name, description, trigger, and errors.
3. Trust project automation only after source review.
4. Use **Run now** once before relying on cron/event trigger.
5. Confirm expected logs and side effects.
6. For event trigger, remove or disable source and verify listener cleanup stops activity.

Source: https://github.com/pragma-sh/pragma/tree/main/packages/automations
