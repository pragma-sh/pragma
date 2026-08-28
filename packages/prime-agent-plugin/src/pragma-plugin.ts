import { createPiPragmaPlugin } from "@pragma-sh/pi-plugin/pragma-plugin-factory";

/** Pragma launcher and interjection watcher for Prime Agent. */
export const primeAgentPlugin = createPiPragmaPlugin({
  plugin: {
    name: "Prime Agent",
    description: "Launch Prime Agent from Pragma.",
  },
  agent: {
    id: "prime-agent",
    name: "Prime Agent",
    iconPath: "assets/prime-butterfly.svg",
    command: ["prime-agent", "--no-session"],
    modelListCommand:
      'prime-agent model list 2>&1 || fnm exec --using default -- prime-agent model list 2>&1 || "$HOME/.bun/bin/prime-agent" model list 2>&1 || "${SHELL:-/bin/sh}" -lc \'prime-agent model list\' 2>&1',
    excludeFeatures: ["questions", "commandApproval", "subagents", "usageLimits"],
  },
});

export default primeAgentPlugin;
