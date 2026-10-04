import { createPiPragmaPlugin, piAccountProviders } from "./pragma-plugin-factory";

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
  accounts: piAccountProviders(
    "pi",
    {
      dirEnv: "PI_CODING_AGENT_DIR",
      defaultDir: "~/.pi/agent",
      file: "auth.json",
      apiKeyType: "api_key",
    },
    {
      openai: {
        // `--offline` skips the startup update check, whose changelog link
        // would otherwise be the first URL the sign-in dialog offers.
        command: ["pi", "--offline"],
        // `/login <provider>` skips the provider picker; the Enter then picks
        // the preselected browser login. Each line is written together with
        // its Enter, so it submits before Pi's autocomplete can open.
        input: ["/login openai-codex", ""],
        instructions:
          "Pi opens and starts its ChatGPT sign-in. Open the sign-in page, then click I've signed in once Pi says it is logged in.",
      },
    },
  ),
});

export default piAgentPlugin;

export { parsePiModels, piAccountProviders } from "./pragma-plugin-factory";
