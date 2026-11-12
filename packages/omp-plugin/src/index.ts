import { createSdkReporter } from "@pragma-sh/pi-plugin/extension-factory";
import { hasPragmaEnvironment, reportAttention } from "@pragma-sh/sdk";

import { askAttentionFields } from "./ask-form";
import { createOmpExtension } from "./extension";

const AGENT_ID = "omp";
const DEBUG_ENV_VAR = "PRAGMA_OMP_PLUGIN_DEBUG";
const LOG_LABEL = "@pragma-sh/omp-plugin";

const env = process.env;

/** Oh My Pi extension that reports lifecycle, questions, and subagent activity to Pragma. */
const pragmaOmpExtension = createOmpExtension({
  reporter: createSdkReporter(
    { agentId: AGENT_ID, debugEnvVar: DEBUG_ENV_VAR, logLabel: LOG_LABEL },
    env,
  ),
  askAttention: async (questions, requestId) => {
    if (!hasPragmaEnvironment(env)) return;
    try {
      await reportAttention({
        agent: AGENT_ID,
        env,
        kind: "question",
        requestId,
        ...askAttentionFields(questions),
      });
    } catch (error) {
      if (env[DEBUG_ENV_VAR] === "1")
        console.warn(`${LOG_LABEL} failed to report to Pragma`, error);
    }
  },
});

export default pragmaOmpExtension;
