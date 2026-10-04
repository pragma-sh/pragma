# @pragma-sh/automations

Write a Pragma automation. Part of [Pragma](https://github.com/pragma-sh/pragma) — a desktop workspace for
running persistent, worktree-scoped coding agents.

Authoring API for trusted TypeScript tasks a Pragma host runs on a cron
schedule, on a workspace event, or on demand.

```sh
bun add @pragma-sh/automations
```

```ts
import { defineAutomation } from "@pragma-sh/automations";

export default defineAutomation({
  name: "Nightly cleanup",
  trigger: { kind: "cron", expression: "0 3 * * *" },
  async run({ client }) {
    /* … */
  },
});
```

Docs: <https://pragma-app.sh/docs/automations>

## License

AGPL-3.0-only. See [LICENSE](https://github.com/pragma-sh/pragma/blob/main/LICENSE).
