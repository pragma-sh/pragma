import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentLaunchArgs,
  applySlashCommand,
  defineAgent,
  resolveAgentOptions,
  slashCommandInvocation,
} from "./agent";
import {
  markdownModes,
  modeProvider,
  parseFrontmatter,
  slashCommandProvider,
  type MarkdownSource,
} from "./agent-discovery";
import {
  ACP_COMMANDS_TTL_MS,
  acpCommandsScript,
  discoverAcpSlashCommands,
  parseAcpCommands,
} from "./acp-discovery";
import type { PluginContext } from "./types";

const agent = defineAgent({
  id: "demo",
  name: "Demo",
  icon: () => null,
  launch: { command: ["demo"] },
  models: [{ id: "m", name: "M", reasoning: [{ id: "high", name: "High" }] }],
  modes: [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ],
  permissionModes: [
    { id: "auto", name: "Auto" },
    { id: "ask", name: "Ask" },
  ],
  slashCommands: [{ name: "review" }, { name: "review" }, { name: "init" }],
  args: {
    model: (id) => ["--model", id],
    reasoning: (id) => ["--effort", id],
    mode: (id) => ["--agent", id],
    permissionMode: (id) => (id === "auto" ? ["--yolo"] : []),
  },
});

const ctx = { project: null } as unknown as PluginContext;

describe("agentLaunchArgs", () => {
  it("applies the first mode and permission mode when none is selected", () => {
    expect(agentLaunchArgs(agent, null)).toEqual(["--agent", "build", "--yolo"]);
  });

  it("orders model, reasoning, mode, then permission mode", () => {
    expect(
      agentLaunchArgs(agent, {
        modelId: "m",
        reasoningId: "high",
        modeId: "plan",
        permissionModeId: "ask",
      }),
    ).toEqual(["--model", "m", "--effort", "high", "--agent", "plan"]);
  });

  it("uses resolved lists for async providers", () => {
    const dynamic = { ...agent, modes: async () => [], permissionModes: async () => [] };
    expect(
      agentLaunchArgs(dynamic, null, {
        modes: [{ id: "x", name: "X" }],
        permissionModes: [{ id: "auto", name: "Auto" }],
      }),
    ).toEqual(["--agent", "x", "--yolo"]);
  });
});

describe("slash commands", () => {
  it("defaults the invocation to /name and composes the prompt", () => {
    expect(slashCommandInvocation(agent, "review")).toBe("/review");
    expect(slashCommandInvocation(agent, { name: "img", invocation: "$img" })).toBe("$img");
    expect(applySlashCommand("/review", "  pr 12 ")).toBe("/review pr 12");
    expect(applySlashCommand("/init", "")).toBe("/init");
  });

  it("resolves options and dedupes commands by name", async () => {
    const options = await resolveAgentOptions(agent, ctx);
    expect(options.slashCommands.map((command) => command.name)).toEqual(["review", "init"]);
    expect(options.modes).toHaveLength(2);
  });

  it("degrades a throwing provider to an empty list", async () => {
    const broken = {
      ...agent,
      slashCommands: async () => {
        throw new Error("scan failed");
      },
    };
    const options = await resolveAgentOptions(broken, ctx);
    expect(options.slashCommands).toEqual([]);
    expect(options.permissionModes).toHaveLength(2);
  });
});

describe("markdown discovery", () => {
  it("parses scalar and block frontmatter", () => {
    expect(
      parseFrontmatter(
        '---\nname: "fix"\ndescription: >-\n  Fix a\n  bug\nargument-hint: [issue]\n---\nbody',
      ),
    ).toEqual({ name: "fix", description: "Fix a bug", "argument-hint": "[issue]" });
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });

  it("title-cases markdown agent profiles as modes", () => {
    expect(
      markdownModes([
        { name: "code-reviewer", frontmatter: { description: "Reviews" }, source: {} as never },
      ]),
    ).toEqual([{ id: "code-reviewer", name: "Code Reviewer", description: "Reviews" }]);
  });
});

/** A context whose host shell prints `stdout` and exits with `status`. */
function scanCtx(stdout: string, status = 0): PluginContext {
  return {
    project: { id: "p", name: "p", path: "/repo" },
    sdk: { exec: { run: async () => [{ status, stdout, stderr: "" }] } },
  } as unknown as PluginContext;
}

describe("option providers", () => {
  it("lists built-in commands before discovered ones and keeps built-ins on failure", async () => {
    const sources: MarkdownSource[] = [{ dir: ".x/commands", layout: "files" }];
    const provider = slashCommandProvider([{ name: "init", description: "Init" }], sources);
    const stdout = "\u001e0\tship.md\n---\ndescription: Ship\n---\n\u001e0\tinit.md\n";
    expect(await provider(scanCtx(stdout))).toEqual([
      { name: "init", description: "Init" },
      { name: "ship", description: "Ship" },
    ]);
    expect(await provider(scanCtx("", 127))).toEqual([{ name: "init", description: "Init" }]);
  });

  it("appends discovered agent profiles after the default mode", async () => {
    const sources: MarkdownSource[] = [
      { dir: ".x/agents", layout: "files", nameFromFrontmatter: true },
    ];
    const provider = modeProvider([{ id: "default", name: "Default" }], sources, (entry) => {
      return entry.frontmatter.mode !== "subagent";
    });
    const stdout =
      "\u001e0\treviewer.md\n---\nname: code-reviewer\n---\n\u001e0\tsub.md\n---\nmode: subagent\n---\n";
    expect(await provider(scanCtx(stdout))).toEqual([
      { id: "default", name: "Default" },
      { id: "code-reviewer", name: "Code Reviewer" },
    ]);
  });
});

/** An ACP `available_commands_update` line announcing `names`. */
function commandsUpdate(names: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: names.map((name) => ({
          name,
          description: `${name} it`,
          ...(name === "plan" ? { input: { hint: "what to plan" } } : {}),
        })),
      },
    },
  });
}

describe("ACP command discovery", () => {
  it("reads the last available_commands_update with argument hints", () => {
    const stdout = [commandsUpdate(["old"]), "noise", commandsUpdate(["plan", "/review"])].join(
      "\n",
    );
    expect(parseAcpCommands(stdout)).toEqual([
      { name: "plan", description: "plan it", argumentHint: "what to plan" },
      { name: "review", description: "/review it" },
    ]);
    expect(parseAcpCommands("")).toEqual([]);
  });

  it("expands {tmp} and quotes every other argument", () => {
    const script = acpCommandsScript({ command: ["junie", "--cache-dir={tmp}", "it's"] });
    expect(script).toContain(`'junie' '--cache-dir='"$work/tmp" 'it'\\''s'`);
  });

  it("merges built-ins, ACP, custom, and file commands with the first name winning", async () => {
    const provider = slashCommandProvider([{ name: "init" }], [], {
      load: async () => [{ name: "imagegen", invocation: "$imagegen" }, { name: "init" }],
    });
    expect(await provider(scanCtx(""))).toEqual([
      { name: "init" },
      { name: "imagegen", invocation: "$imagegen" },
    ]);
  });
});

/** The names of a command list, for compact assertions. */
function commandNames(list: { name: string }[]): string[] {
  return list.map((command) => command.name);
}

describe("ACP command cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a fresh list from cache and a stale one while refreshing", async () => {
    let calls = 0;
    const lists = [["first"], ["second"]];
    const cacheCtx = {
      project: { id: "cache", name: "cache", path: "/cache-test" },
      sdk: {
        exec: {
          run: async () => [{ status: 0, stderr: "", stdout: commandsUpdate(lists[calls++]!) }],
        },
      },
    } as unknown as PluginContext;
    const source = { command: ["cache-agent", "acp"] };
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(commandNames(await discoverAcpSlashCommands(cacheCtx, source))).toEqual(["first"]);
    expect(commandNames(await discoverAcpSlashCommands(cacheCtx, source))).toEqual(["first"]);
    expect(calls).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(now + ACP_COMMANDS_TTL_MS + 1);
    expect(commandNames(await discoverAcpSlashCommands(cacheCtx, source))).toEqual(["first"]);
    await vi.waitFor(() => expect(calls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commandNames(await discoverAcpSlashCommands(cacheCtx, source))).toEqual(["second"]);
  });

  it("does not cache an empty probe and shares one probe between concurrent callers", async () => {
    let calls = 0;
    const outputs = ["", commandsUpdate(["ready"])];
    const retryCtx = {
      project: { id: "retry", name: "retry", path: "/retry-test" },
      sdk: {
        exec: {
          run: async () => {
            const stdout = outputs[calls++] ?? "";
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [{ status: 0, stderr: "", stdout }];
          },
        },
      },
    } as unknown as PluginContext;
    const source = { command: ["retry-agent", "acp"] };
    const [first, second] = await Promise.all([
      discoverAcpSlashCommands(retryCtx, source),
      discoverAcpSlashCommands(retryCtx, source),
    ]);
    expect([first, second, calls]).toEqual([[], [], 1]);
    expect(
      (await discoverAcpSlashCommands(retryCtx, source)).map((command) => command.name),
    ).toEqual(["ready"]);
  });
});
