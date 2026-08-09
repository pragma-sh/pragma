import { createPiPragmaPlugin } from "@pragma/pi-plugin/pragma-plugin-factory";

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
    command: ["prime-agent"],
    modelListCommand:
      'prime-agent model list 2>/dev/null || fnm exec --using default -- prime-agent model list 2>/dev/null || "$HOME/.bun/bin/prime-agent" model list 2>/dev/null || "${SHELL:-/bin/sh}" -lc \'prime-agent model list\' 2>/dev/null',
    excludeFeatures: ["questions", "commandApproval", "subagents", "usageLimits"],
  },
});

export default primeAgentPlugin;
