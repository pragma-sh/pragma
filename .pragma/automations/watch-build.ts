import { defineAutomation } from "@pragma/automations";

export default defineAutomation({
  name: "test.txt watcher",
  description: "Runs when test.txt is created in cwd",
  trigger: {
    type: "event",
    listen(ctx, fire) {
      let existed = false;
      let initialized = false;

      async function check(): Promise<void> {
        let exists = false;
        try {
          exists = (await ctx.fs.find("test.txt")).includes("test.txt");
        } catch {
          exists = false;
        }

        if (initialized && exists && !existed) {
          fire({ path: "test.txt" });
        }

        existed = exists;
        initialized = true;
      }

      void check();
      const timer = setInterval(() => {
        void check();
      }, 1_000);
      return () => clearInterval(timer);
    },
  },
  async run(ctx, payload) {
    ctx.log.info("test.txt created", payload);
  },
});
