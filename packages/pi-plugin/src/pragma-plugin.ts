import { createPiPragmaPlugin } from "./pragma-plugin-factory";

/** Pragma launcher and interjection watcher for Pi CLI. */
export const piAgentPlugin = createPiPragmaPlugin({
  plugin: {
    name: "Pi",
    description: "Launch Pi CLI from Pragma.",
  },
  agent: {
    id: "pi",
    name: "Pi",
    iconPath: "assets/pi-badge.svg",
    command: ["pi"],
    modelListCommand:
      'pi --list-models 2>/dev/null || fnm exec --using default -- pi --list-models 2>/dev/null || "$HOME/.bun/bin/pi" --list-models 2>/dev/null || "${SHELL:-/bin/sh}" -lc \'pi --list-models\' 2>/dev/null',
    excludeFeatures: ["questions", "commandApproval", "subagents", "usageLimits"],
  },
});

export default piAgentPlugin;

export { parsePiModels } from "./pragma-plugin-factory";
