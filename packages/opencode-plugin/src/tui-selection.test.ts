import { describe, expect, it } from "vitest";

import type { OpenCodeV2Model } from "./opencode-v2-catalog";
import {
  createOutputFeed,
  planIsEmpty,
  planSelection,
  runSelectionPlan,
  type SelectionPlan,
  type SelectionSession,
} from "./tui-selection";

const MODELS: OpenCodeV2Model[] = [
  { id: "gpt-5.6-sol", providerID: "openai", name: "GPT-5.6 Sol", variants: ["low", "high"] },
  { id: "gpt-5.6-sol", providerID: "opencode", name: "GPT-5.6 Sol", variants: [] },
];
const PROVIDERS = new Map([
  ["openai", "OpenAI"],
  ["opencode", "OpenCode"],
]);

describe("planSelection", () => {
  it("searches by the model's name and its provider's title, never its id", () => {
    expect(
      planSelection(
        { modelId: "openai/gpt-5.6-sol", reasoningId: "high", modeId: "plan" },
        MODELS,
        PROVIDERS,
      ),
    ).toEqual({
      agent: "plan",
      modelQuery: "GPT-5.6 Sol OpenAI",
      modelHasVariants: true,
      variant: "high",
    });
    expect(planSelection({ modelId: "opencode/gpt-5.6-sol" }, MODELS, PROVIDERS).modelQuery).toBe(
      "GPT-5.6 Sol OpenCode",
    );
  });

  it("leaves alone a model OpenCode does not list and a variant the model lacks", () => {
    expect(planIsEmpty(planSelection({ modelId: "default" }, MODELS, PROVIDERS))).toBe(true);
    expect(planIsEmpty(planSelection(undefined, MODELS, PROVIDERS))).toBe(true);
    expect(
      planSelection({ modelId: "openai/gpt-5.6-sol", reasoningId: "max" }, MODELS, PROVIDERS)
        .variant,
    ).toBeUndefined();
  });
});

describe("createOutputFeed", () => {
  it("finds a title across chunks and escape sequences, but not from before the mark", async () => {
    const feed = createOutputFeed();
    feed.push("\x1b[1mSelect model\x1b[0m");
    feed.mark();
    expect(feed.has("select model")).toBe(false);
    const found = feed.waitFor("select agent", 1000);
    feed.push("\x1b[3;5HSelect\x1b[");
    feed.push("1m agent");
    expect(await found).toBe(true);
  });

  // OpenCode sets its title with an OSC ended by ST, and draws each word of
  // the footer hint as its own positioned, coloured run.
  it("reads OpenCode's start screen past an OSC that ends in ST", () => {
    const feed = createOutputFeed();
    feed.push(
      "\x1b]0;OpenCode\x1b\\\x1b[26;84H\x1b[38;2;237;237;237mctrl+p \x1b[0m" +
        "\x1b[26;91H\x1b[38;2;135;135;135mcommands\x1b[0m\x1b]0;later\x07",
    );
    expect(feed.has("ctrl+p commands")).toBe(true);
  });

  it("gives up after the timeout", async () => {
    const feed = createOutputFeed((run) => run());
    expect(await feed.waitFor("select model", 10)).toBe(false);
  });
});

/**
 * A stand-in for the OpenCode TUI: each write is recorded, and a write found
 * in `draws` makes the TUI draw that text. Waits that are never satisfied
 * time out at once.
 */
function fakeTui(draws: Record<string, string>, clock: () => number = () => 0) {
  const feed = createOutputFeed((run) => run());
  const keys: string[] = [];
  const io: SelectionSession = {
    feed,
    sendKeys: async (data) => {
      keys.push(data);
      const drawn = draws[data];
      if (drawn) feed.push(drawn);
    },
    sleep: async () => {},
    now: clock,
  };
  return { io, keys, feed };
}

const FULL_PLAN: SelectionPlan = {
  agent: "plan",
  modelQuery: "GPT-5.6 Sol OpenAI",
  modelHasVariants: true,
  variant: "high",
};

describe("runSelectionPlan", () => {
  it("chooses the agent, then the model, then the variant picker that opened by itself", async () => {
    const { io, keys, feed } = fakeTui({
      "\x18a": "Select agent",
      "\x18m": "Select model",
    });
    feed.push("shift+tab agents  ctrl+p commands");
    // The variant picker opens on the Enter that confirms the model.
    let enters = 0;
    const send = io.sendKeys;
    io.sendKeys = async (data) => {
      await send(data);
      if (data === "\r" && ++enters === 2) feed.push("variant");
    };
    expect(await runSelectionPlan(io, FULL_PLAN)).toEqual({
      agent: true,
      model: true,
      variant: true,
    });
    expect(keys).toEqual([
      "\x18a",
      "plan",
      "\r",
      "\x18m",
      "GPT-5.6 Sol OpenAI",
      "\r",
      "high",
      "\r",
    ]);
  });

  it("reaches the variant through the command palette when its picker stays closed", async () => {
    const { io, keys, feed } = fakeTui({ "\x18m": "Select model", "\x10": "Commands" });
    feed.push("ctrl+p commands");
    let enters = 0;
    const send = io.sendKeys;
    io.sendKeys = async (data) => {
      await send(data);
      if (data === "\r" && ++enters === 2) feed.push("variant");
    };
    const outcome = await runSelectionPlan(io, { ...FULL_PLAN, agent: undefined });
    expect(outcome).toEqual({ agent: false, model: true, variant: true });
    expect(keys).toEqual([
      "\x18m",
      "GPT-5.6 Sol OpenAI",
      "\r",
      "\x10",
      "Switch model variant",
      "\r",
      "high",
      "\r",
    ]);
  });

  // Typed into the prompt box, a search and its Enter would be sent to the model.
  it("types nothing when a picker does not open, and backs out with Escape", async () => {
    const { io, keys, feed } = fakeTui({});
    feed.push("ctrl+p commands");
    expect(await runSelectionPlan(io, FULL_PLAN)).toEqual({
      agent: false,
      model: false,
      variant: false,
    });
    expect(keys).toEqual(["\x18a", "\x1b", "\x18m", "\x1b"]);
  });

  it("closes the variant picker when no variant was chosen", async () => {
    const { io, keys, feed } = fakeTui({ "\x18m": "Select model", "\r": "variant" });
    feed.push("ctrl+p commands");
    await runSelectionPlan(io, { modelQuery: "GPT-5.6 Sol OpenAI", modelHasVariants: true });
    expect(keys).toEqual(["\x18m", "GPT-5.6 Sol OpenAI", "\r", "\x1b"]);
  });

  it("backs out of a search that matches nothing", async () => {
    const { io, keys, feed } = fakeTui({ "\x18a": "Select agent", ghost: "No results found" });
    feed.push("ctrl+p commands");
    expect((await runSelectionPlan(io, { agent: "ghost" })).agent).toBe(false);
    expect(keys).toEqual(["\x18a", "ghost", "\x1b"]);
  });

  it("sends nothing before the start screen is up", async () => {
    const { io, keys } = fakeTui({ "\x18a": "Select agent" });
    await runSelectionPlan(io, FULL_PLAN);
    expect(keys).toEqual([]);
  });

  // The launch prompt arrives on its own timer; a step that could still be
  // typing when it does is not started.
  it("drops what is left once its time is up", async () => {
    let time = 0;
    const { io, keys, feed } = fakeTui(
      { "\x18a": "Select agent", "\x18m": "Select model" },
      () => time,
    );
    feed.push("ctrl+p commands");
    const send = io.sendKeys;
    io.sendKeys = async (data) => {
      await send(data);
      // Choosing the agent used up the whole budget.
      if (data === "\r") time = 10_000;
    };
    expect(await runSelectionPlan(io, FULL_PLAN)).toEqual({
      agent: true,
      model: false,
      variant: false,
    });
    expect(keys).toEqual(["\x18a", "plan", "\r"]);
  });
});
