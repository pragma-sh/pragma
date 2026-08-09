import { createPiExtension } from "@pragma/pi-plugin/extension-factory";

/** Prime Agent extension that reports lifecycle and streaming transcript updates to Pragma. */
const pragmaPrimeAgentExtension = createPiExtension({
  agentId: "prime-agent",
  debugEnvVar: "PRAGMA_PRIME_AGENT_PLUGIN_DEBUG",
  logLabel: "@pragma/prime-agent-plugin",
});

export default pragmaPrimeAgentExtension;
