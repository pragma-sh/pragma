import { createPiExtension } from "./extension-factory";

/** Pi extension that reports lifecycle and streaming transcript updates to Pragma. */
const pragmaPiExtension = createPiExtension({
  agentId: "pi",
  debugEnvVar: "PRAGMA_PI_PLUGIN_DEBUG",
  logLabel: "@pragma/pi-plugin",
});

export default pragmaPiExtension;
