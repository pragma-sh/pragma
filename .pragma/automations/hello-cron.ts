import { defineAutomation } from "@pragma-sh/automations";

export default defineAutomation({
  name: "Hello Cron",
  description: "Logs a greeting every 5 minutes",
  trigger: { type: "cron", schedule: "*/5 * * * *" },
  async run(ctx) {
    ctx.log.info("Hello from cron automation!", {
      project: ctx.paths.project,
      time: new Date().toISOString(),
    });
  },
});
