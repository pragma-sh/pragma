import { describe, expect, it, vi } from "vitest";

import { parsePiModels, piAgentPlugin } from "./pragma-plugin";
import { PI_ACCOUNT_ENTRIES } from "./pragma-plugin-factory";

describe("pi watcher", () => {
  it("submits interjections and clears status on session exit", async () => {
    const watcher = piAgentPlugin.watchers?.[0];
    expect(watcher).toBeDefined();

    const controller = new AbortController();
    const report = vi.fn(async () => {});
    const sendKeys = vi.fn(async () => {});
    const context = {
      sdk: {
        agents: {
          connect: async () => ({
            async *[Symbol.asyncIterator]() {
              try {
                yield {
                  type: "agentInput",
                  input: {
                    agent: "pi",
                    worktreeId: "worktree-1",
                    tabId: "tab-1",
                    text: "continue",
                  },
                };
              } finally {
                controller.abort();
              }
            },
          }),
          report,
        },
      },
      agentId: "pi",
      config: undefined,
      session: { id: "session-1", tabId: "tab-1", worktreeId: "worktree-1" },
      output: (async function* () {})(),
      sendKeys,
      reportMessage: async () => {},
      signal: controller.signal,
    };

    await watcher?.watch(context as never);

    expect(sendKeys).toHaveBeenNthCalledWith(1, "\x1b[200~continue\x1b[201~");
    expect(sendKeys).toHaveBeenNthCalledWith(2, "\x1b[13;3u");
    expect(report).toHaveBeenCalledWith({
      agent: "pi",
      tabId: "tab-1",
      worktreeId: "worktree-1",
      status: "cleared",
      attentionKind: null,
    });
  });
});

describe("parsePiModels", () => {
  it("clears late terminal-query text and submits prefills with Kitty Enter", () => {
    expect(piAgentPlugin.agents?.[0]).toMatchObject({
      startupInput: [{ delayMs: 1800, data: "\x15" }],
      prefillSubmit: "\x1b[13u",
    });
  });

  it("checks Node managers when the plugin host PATH omits Pi", async () => {
    const run = vi.fn(async () => [{ stdout: "", stderr: "", status: 0 }]);
    const models = piAgentPlugin.agents?.[0]?.models;

    expect(typeof models).toBe("function");
    if (typeof models === "function") {
      await models({ sdk: { exec: { run } } } as never);
    }

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.stringMatching(
            /fnm exec --using default -- pi --list-models.*"\$HOME\/\.bun\/bin\/pi" --list-models/,
          ),
        ],
      }),
    );
  });

  it("parses model rows and thinking support", () => {
    expect(
      parsePiModels(`provider        model             context  max-out  thinking  images
github-copilot  claude-haiku-4.5  200K     64K      yes       yes
github-copilot  gpt-4.1           128K     16.4K    no        yes
invalid row`),
    ).toEqual([
      {
        id: "github-copilot/claude-haiku-4.5",
        name: "claude-haiku-4.5 (github-copilot)",
        reasoning: [
          { id: "off", name: "Off" },
          { id: "minimal", name: "Minimal" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
          { id: "xhigh", name: "Extra High" },
          { id: "max", name: "Max" },
        ],
      },
      {
        id: "github-copilot/gpt-4.1",
        name: "gpt-4.1 (github-copilot)",
      },
    ]);
  });
});

describe("pi account providers", () => {
  it("identifies each of Pi's sign-ins without relocating its agent directory", () => {
    const accounts = piAgentPlugin.accounts ?? [];
    expect(accounts.map((provider) => provider.provider)).toEqual(
      PI_ACCOUNT_ENTRIES.map((entry) => entry.provider),
    );
    expect(accounts.slice(0, 4).map((provider) => provider.provider)).toEqual([
      "openai",
      "anthropic",
      "github-copilot",
      "opencode-go",
    ]);
    for (const provider of accounts) {
      expect(provider.agent).toBe("pi");
      // The agent dir also holds the Pragma extension: moving it per account
      // would stop status reporting.
      expect(provider.env).toBeUndefined();
      expect(provider.identify).toBeTypeOf("function");
    }
    expect(accounts[0]?.credentialPath?.(null)).toBe(
      "$PI_CODING_AGENT_DIR or ~/.pi/agent/auth.json",
    );
  });

  it("switches ChatGPT accounts by swapping auth.json, signing in through /login", () => {
    const accounts = piAgentPlugin.accounts ?? [];
    const openai = accounts.find((provider) => provider.provider === "openai");
    expect(openai?.swap).toBeDefined();
    expect(openai?.login).toMatchObject({
      command: ["pi", "--offline"],
      input: ["/login openai-codex", ""],
    });
    expect(openai?.credentialPath?.("/h/1")).toBe("/h/1/auth.json");
    // Only ChatGPT has a scripted sign-in.
    for (const provider of accounts.filter((candidate) => candidate !== openai)) {
      expect(provider.login).toBeUndefined();
    }
  });

  it("lends every sign-in it may share, and swaps them all", () => {
    const accounts = piAgentPlugin.accounts ?? [];
    const kind = (provider: string) =>
      accounts.find((candidate) => candidate.provider === provider)?.sharedToken?.kind;
    expect(kind("openai")).toBe("chatgpt");
    // pi-ai's Copilot sign-in goes through VS Code's GitHub OAuth app.
    expect(kind("github-copilot")).toBe("github-copilot:Iv1.b507a08c87ecfe98");
    expect(kind("openrouter")).toBe("key:openrouter");
    expect(kind("opencode-go")).toBe("key:opencode-go");
    // Anthropic is key-only: a Claude subscription sign-in is never lent.
    expect(kind("anthropic")).toBe("key:anthropic");
    for (const provider of accounts) {
      expect(provider.swap).toBeDefined();
      expect(provider.sharedToken?.write).toBeTypeOf("function");
    }
  });

  // Claude Free/Pro/Max OAuth may only be used in Claude Code and claude.ai;
  // Gemini CLI and Antigravity OAuth are restricted to Google's own tools.
  it("identifies Anthropic and Google by API key only", () => {
    const keyOnly = PI_ACCOUNT_ENTRIES.filter((entry) => entry.apiKeyOnly).map(
      (entry) => entry.provider,
    );
    expect(keyOnly).toContain("anthropic");
    expect(keyOnly).toContain("google");
    expect(keyOnly).not.toContain("openai");
    expect(keyOnly).not.toContain("github-copilot");
  });

  it("merges Pi's ChatGPT sign-in with the Codex account of the same email", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pi-accounts-"));
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/profile": { email: "dev@example.com" } }),
    ).toString("base64url");
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", access: `h.${payload}.s`, refresh: "r" } }),
    );
    const openai = piAgentPlugin.accounts?.find((provider) => provider.provider === "openai");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const identity = await openai?.identify?.({
        account: { loginId: "default", home: null, env: {} },
      } as never);
      expect(identity?.id).toBe("dev@example.com");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
