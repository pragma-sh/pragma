import { describe, expect, it } from "vitest";

import {
  applyAutoModeFilters,
  EMPTY_AUTO_MODE,
  globToRegExp,
  mergeAutoMode,
  parseAutoMode,
} from "./automode.ts";

const candidates = [
  { id: "claude-code", models: [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }] },
  { id: "codex", models: [{ id: "gpt-6-astra" }, { id: "gpt-5.6-luna" }] },
  { id: "opencode", models: [{ id: "anthropic/claude-sonnet-5" }, { id: "openai/gpt-6-astra" }] },
  { id: "cursor", models: [] },
];

function merged(source: string) {
  return mergeAutoMode(EMPTY_AUTO_MODE, parseAutoMode(source).preferences);
}

describe("parseAutoMode", () => {
  it("reads frontmatter filters, priority, and the body", () => {
    const { preferences, warnings } = parseAutoMode(
      [
        "---",
        "agents:",
        "  include: [claude-code, codex]",
        "  exclude: cursor",
        "models:",
        '  exclude: ["*haiku*"]',
        "priority: Speed",
        "---",
        "Use Codex for CI fixes.",
        "",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(preferences).toEqual({
      agents: { include: ["claude-code", "codex"], exclude: ["cursor"] },
      models: { include: [], exclude: ["*haiku*"] },
      priority: "speed",
      notes: "Use Codex for CI fixes.",
    });
  });

  it("treats a bare list as include", () => {
    expect(parseAutoMode("---\nagents: [codex]\n---\n").preferences.agents).toEqual({
      include: ["codex"],
      exclude: [],
    });
  });

  it("keeps the body when the frontmatter is broken", () => {
    const { preferences, warnings } = parseAutoMode("---\nagents: [unclosed\n---\nPrefer Codex.");
    expect(preferences.notes).toBe("Prefer Codex.");
    expect(preferences.agents.include).toEqual([]);
    expect(warnings[0]).toMatch(/not valid YAML/);
  });

  it("warns on unknown keys and bad priorities", () => {
    const { warnings } = parseAutoMode("---\nprefer: codex\npriority: vibes\n---\n");
    expect(warnings).toEqual([
      'unknown frontmatter key "prefer"',
      "priority must be one of accuracy, speed, efficiency, balanced",
    ]);
  });

  it("treats a file with no frontmatter as all notes", () => {
    expect(parseAutoMode("Just prose.").preferences).toEqual({
      ...EMPTY_AUTO_MODE,
      notes: "Just prose.",
    });
    expect(parseAutoMode("").preferences).toBe(EMPTY_AUTO_MODE);
  });
});

describe("mergeAutoMode", () => {
  it("lets the project win while unioning excludes", () => {
    const global = parseAutoMode(
      "---\nagents:\n  include: [codex]\n  exclude: [cursor]\npriority: speed\n---\nglobal notes",
    ).preferences;
    const project = parseAutoMode(
      "---\nagents:\n  include: [claude-code]\n  exclude: [opencode]\npriority: accuracy\n---\nproject notes",
    ).preferences;
    expect(mergeAutoMode(global, project)).toEqual({
      agents: { include: ["claude-code"], exclude: ["cursor", "opencode"] },
      models: { include: [], exclude: [] },
      priority: "accuracy",
      notes: { project: "project notes", global: "global notes" },
    });
  });

  it("falls back to the global include when the project has none", () => {
    const global = parseAutoMode("---\nagents: [codex]\n---\n").preferences;
    expect(mergeAutoMode(global, EMPTY_AUTO_MODE).agents.include).toEqual(["codex"]);
  });
});

describe("globToRegExp", () => {
  it("matches case-insensitively and escapes regex characters", () => {
    expect(globToRegExp("gpt-5.6*").test("GPT-5.6-luna")).toBe(true);
    expect(globToRegExp("gpt-5.6*").test("gpt-506")).toBe(false);
  });
});

describe("applyAutoModeFilters with launcher ids", () => {
  const qualified = [
    { id: "pragma.claude-code", models: [{ id: "opus" }, { id: "sonnet" }] },
    { id: "@pragma-sh/opencode-plugin.opencode", models: [{ id: "openai/gpt-6" }] },
    { id: "@pragma-sh/codex-plugin.codex", models: [{ id: "gpt-6-astra" }] },
  ];

  it("matches the short id users write against plugin-qualified ids", () => {
    const ids = applyAutoModeFilters(
      qualified,
      merged("---\nagents:\n  include: [claude-code, opencode]\n---\n"),
    ).map((candidate) => candidate.id);
    expect(ids).toEqual(["pragma.claude-code", "@pragma-sh/opencode-plugin.opencode"]);
  });

  it("scopes agent/model patterns by the short id too", () => {
    const result = applyAutoModeFilters(
      qualified,
      merged("---\nmodels:\n  exclude: ['claude-code/sonnet']\n---\n"),
    );
    expect(result[0]?.models).toEqual([{ id: "opus" }]);
  });

  it("still accepts the full qualified id", () => {
    const ids = applyAutoModeFilters(
      qualified,
      merged("---\nagents:\n  exclude: ['@pragma-sh/codex-plugin.codex']\n---\n"),
    ).map((candidate) => candidate.id);
    expect(ids).not.toContain("@pragma-sh/codex-plugin.codex");
  });
});

describe("applyAutoModeFilters", () => {
  it("returns every candidate when there are no preferences", () => {
    expect(applyAutoModeFilters(candidates, merged(""))).toEqual(candidates);
  });

  it("applies agent include and exclude", () => {
    const ids = applyAutoModeFilters(
      candidates,
      merged("---\nagents:\n  include: ['c*']\n  exclude: [cursor]\n---\n"),
    ).map((candidate) => candidate.id);
    expect(ids).toEqual(["claude-code", "codex"]);
  });

  it("scopes an agent-qualified model include to that agent only", () => {
    const result = applyAutoModeFilters(candidates, merged("---\nmodels: ['codex/gpt-6*']\n---\n"));
    expect(result.find((c) => c.id === "codex")?.models).toEqual([{ id: "gpt-6-astra" }]);
    expect(result.find((c) => c.id === "claude-code")?.models).toHaveLength(3);
  });

  it("keeps provider-qualified model ids as bare patterns", () => {
    const result = applyAutoModeFilters(
      candidates,
      merged("---\nmodels:\n  exclude: ['anthropic/*', '*haiku']\n---\n"),
    );
    expect(result.find((c) => c.id === "opencode")?.models).toEqual([{ id: "openai/gpt-6-astra" }]);
    expect(result.find((c) => c.id === "claude-code")?.models.map((m) => m.id)).toEqual([
      "opus",
      "sonnet",
    ]);
  });

  it("drops an agent whose models were all filtered out, but keeps one with no list", () => {
    const ids = applyAutoModeFilters(candidates, merged("---\nmodels: ['codex/*']\n---\n"))
      .filter((c) => c.id === "codex" || c.id === "cursor")
      .map((c) => c.id);
    expect(ids).toEqual(["codex", "cursor"]);
    const excluded = applyAutoModeFilters(
      candidates,
      merged("---\nmodels:\n  exclude: ['codex/*']\n---\n"),
    ).map((c) => c.id);
    expect(excluded).not.toContain("codex");
    expect(excluded).toContain("cursor");
  });

  it("drops an unknown model list when a model filter names the agent", () => {
    // `cursor` lists no models; a bare exclude could still match its default,
    // so it must not survive with no model id and bypass the hard filter.
    const ids = applyAutoModeFilters(
      candidates,
      merged("---\nmodels:\n  exclude: ['*haiku*']\n---\n"),
    ).map((c) => c.id);
    expect(ids).not.toContain("cursor");
    expect(ids).toContain("codex");
    // An agent-scoped filter leaves unrelated unknown-list agents alone.
    const scoped = applyAutoModeFilters(candidates, merged("---\nmodels: ['codex/*']\n---\n")).map(
      (c) => c.id,
    );
    expect(scoped).toContain("cursor");
  });
});
