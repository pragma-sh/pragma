import {
  createPiPragmaPlugin,
  piAccountProviders,
} from "@pragma-sh/pi-plugin/pragma-plugin-factory";

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
  // Prime Agent is Pi-derived: same `auth.json` entries, its own directory.
  accounts: piAccountProviders(
    "prime-agent",
    {
      dirEnv: "PRIME_AGENT_CODING_AGENT_DIR",
      defaultDir: "~/.prime/agent",
      file: "auth.json",
      apiKeyType: "api_key",
    },
    {
      openai: {
        command: ["prime-agent", "--no-session"],
        // Prime Agent's `/login` takes no provider and lists signed-in
        // providers first, which an in-place sign-in has just signed out of;
        // typing filters its picker to ChatGPT instead. Prime starts its
        // daemon and kernel first, so it needs longer than Pi before typing.
        input: ["/login", "ChatGPT"],
        inputDelayMs: 6000,
        instructions:
          "Prime Agent opens its ChatGPT sign-in in your browser. Finish there, then click I've signed in once Prime Agent says it is logged in.",
      },
    },
  ),
});

export default primeAgentPlugin;
