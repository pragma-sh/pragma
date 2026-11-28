import type { AgentLaunchSelection } from "@pragma-sh/plugin/catalog";

import { openCodeV2ModelId, type OpenCodeV2Model } from "./opencode-v2-catalog";

/**
 * Applies a launch's model, reasoning variant, and agent to OpenCode v2 by
 * driving its TUI, because v2 has no launch flag for any of them.
 *
 * This is a workaround, and the weakest part of the integration: it types
 * into pickers found by their on-screen titles, inside the few seconds between
 * OpenCode's start screen appearing and Pragma typing the launch prompt. See
 * "OpenCode v2 selection" in this package's AGENTS.md before changing it.
 *
 * The one rule that keeps it safe: **text is typed only after the title of the
 * picker it belongs to has just been drawn.** A shortcut that opened nothing is
 * followed by Escape, never by text and Enter — typed into the prompt box,
 * those would send a message to the model. (OpenCode opens its variant picker
 * after a model choice only some of the time, which is exactly that trap.)
 *
 * Verified against OpenCode 2.1.1.
 */

/** OpenCode's "Switch agent" shortcut (Ctrl+X, A). */
const OPEN_AGENT_PICKER = "\x18a";
/** OpenCode's "Switch model" shortcut (Ctrl+X, M). */
const OPEN_MODEL_PICKER = "\x18m";
/** OpenCode's command palette (Ctrl+P). */
const OPEN_COMMAND_PALETTE = "\x10";
const ESCAPE = "\x1b";
const ENTER = "\r";

/** Text OpenCode draws, lower-cased; each is what proves a view is on screen. */
const HOME_HINT = "ctrl+p commands";
const AGENT_PICKER_TITLE = "select agent";
const MODEL_PICKER_TITLE = "select model";
/**
 * OpenCode redraws only the cells that changed. The variant picker replaces
 * the model picker (or the palette) in place, so of its title "Select variant"
 * only the second word is ever sent; the other titles open over the start
 * screen and are drawn whole.
 */
const VARIANT_PICKER_TITLE = "variant";
const COMMAND_PALETTE_TITLE = "commands";
const VARIANT_COMMAND = "Switch model variant";
const NO_RESULTS = "no results found";

/**
 * How long OpenCode has to draw its start screen after the watcher attaches.
 * The watcher starts when the launch is prepared; the host then authorizes the
 * run and OpenCode boots, which together can take several seconds.
 */
const HOME_TIMEOUT_MS = 20_000;
/** How long a picker has to draw its title after its shortcut. */
const PICKER_TIMEOUT_MS = 700;
/** Pause after typing a search, so the list has filtered before Enter. */
const SEARCH_SETTLE_MS = 200;
/** How long the variant picker has to open by itself after a model choice. */
const VARIANT_AUTO_OPEN_MS = 400;
/**
 * Total time the watcher may spend typing, from the start screen appearing.
 * Pragma types the launch prompt on a fixed delay it does not coordinate with
 * this, so the pickers are driven as fast as they respond and anything still
 * pending when this runs out is dropped rather than typed over the prompt.
 */
const BUDGET_MS = 3500;
/** A step is not started with less than this left. */
const STEP_COST_MS = PICKER_TIMEOUT_MS + SEARCH_SETTLE_MS;

/** How much trailing output is kept while looking for a title. */
const BUFFER_LIMIT = 32_768;

// An OSC body stops at the first ESC as well as at BEL: one that ends in ST
// (ESC \) would otherwise run on to a terminator far later in the stream and
// take every title in between with it. OpenCode opens with such sequences.
// oxlint-disable-next-line no-control-regex -- ANSI CSI/OSC framing uses ESC and BEL bytes.
const CONTROL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** What the watcher will do in the TUI for one launch. */
export interface SelectionPlan {
  /** Agent id to choose in "Switch agent". */
  agent?: string;
  /** Search text that finds the model in "Switch model": its name and provider title. */
  modelQuery?: string;
  /** Whether the chosen model has variants, so its picker may open by itself. */
  modelHasVariants?: boolean;
  /** Reasoning variant to choose. */
  variant?: string;
}

/**
 * Turns a launch selection into picker inputs.
 *
 * The model picker matches a model's display name and its provider's title
 * together and never its id, so the query is built from OpenCode's own lists.
 * A model id OpenCode does not list is left alone (searching for it could
 * select a near miss), and a variant is applied only with a model that has it.
 * The agent is not checked: a project can define its own, and a search with no
 * match is backed out of.
 */
export function planSelection(
  selection: AgentLaunchSelection | undefined,
  models: OpenCodeV2Model[],
  providerTitles: Map<string, string>,
): SelectionPlan {
  const plan: SelectionPlan = {};
  if (selection?.modeId) plan.agent = selection.modeId;
  const model = selection?.modelId
    ? models.find((candidate) => openCodeV2ModelId(candidate) === selection.modelId)
    : undefined;
  if (!model) return plan;
  plan.modelQuery = `${model.name} ${providerTitles.get(model.providerID) ?? model.providerID}`;
  plan.modelHasVariants = model.variants.length > 0;
  if (selection?.reasoningId && model.variants.includes(selection.reasoningId)) {
    plan.variant = selection.reasoningId;
  }
  return plan;
}

/** Whether a plan asks for anything at all. */
export function planIsEmpty(plan: SelectionPlan): boolean {
  return !plan.agent && !plan.modelQuery;
}

/** The session output seen since the last {@link OutputFeed.mark}, as searchable text. */
export interface OutputFeed {
  /** Feeds one output chunk. */
  push: (chunk: string) => void;
  /** Forgets everything seen so far: what follows is output caused by the next keys. */
  mark: () => void;
  /** Whether `needle` (lower-case) has been drawn since the mark. */
  has: (needle: string) => boolean;
  /** Resolves true once `needle` is drawn, or false after `timeoutMs`. */
  waitFor: (needle: string, timeoutMs: number) => Promise<boolean>;
}

/** Creates a feed. `setTimer` is injectable for tests. */
export function createOutputFeed(
  setTimer: (run: () => void, ms: number) => unknown = setTimeout,
): OutputFeed {
  let raw = "";
  let waiters: Array<{ needle: string; settle: (found: boolean) => void }> = [];
  // Escape sequences can straddle chunks, so the kept output is re-read whole.
  const seen = (): string => raw.replace(CONTROL_SEQUENCE, " ").replace(/\s+/g, " ").toLowerCase();
  const has = (needle: string): boolean => seen().includes(needle);
  return {
    push: (chunk) => {
      raw = `${raw}${chunk}`.slice(-BUFFER_LIMIT);
      if (waiters.length === 0) return;
      const text = seen();
      const found = waiters.filter((waiter) => text.includes(waiter.needle));
      waiters = waiters.filter((waiter) => !found.includes(waiter));
      for (const waiter of found) waiter.settle(true);
    },
    mark: () => {
      raw = "";
    },
    has,
    waitFor: (needle, timeoutMs) => {
      if (has(needle)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const waiter = { needle, settle: resolve };
        waiters.push(waiter);
        setTimer(() => {
          waiters = waiters.filter((candidate) => candidate !== waiter);
          resolve(false);
        }, timeoutMs);
      });
    },
  };
}

/** What {@link runSelectionPlan} needs from the session. */
export interface SelectionSession {
  feed: OutputFeed;
  sendKeys: (data: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Clock, injectable for tests. */
  now: () => number;
}

/** A session whose start screen is up, with the time left to type into it. */
interface SelectionIo extends SelectionSession {
  remainingMs: () => number;
}

/** What was applied; for the watcher's log line and for tests. */
export interface SelectionOutcome {
  agent: boolean;
  model: boolean;
  variant: boolean;
}

/**
 * Opens a picker, and only once its title is drawn searches it and presses
 * Enter. Returns false, with the picker closed, when it did not open, the
 * search matched nothing, or too little time is left to finish.
 */
async function pick(io: SelectionIo, open: string, title: string, query: string): Promise<boolean> {
  if (io.remainingMs() < STEP_COST_MS) return false;
  io.feed.mark();
  await io.sendKeys(open);
  if (!(await io.feed.waitFor(title, PICKER_TIMEOUT_MS))) {
    // Whatever the shortcut did open must not be left to swallow the prompt.
    await io.sendKeys(ESCAPE);
    return false;
  }
  return search(io, query);
}

/** Searches the picker that is open and presses Enter on its first result. */
async function search(io: SelectionIo, query: string): Promise<boolean> {
  io.feed.mark();
  await io.sendKeys(query);
  await io.sleep(SEARCH_SETTLE_MS);
  if (io.feed.has(NO_RESULTS)) {
    await io.sendKeys(ESCAPE);
    return false;
  }
  io.feed.mark();
  // Enter goes in its own write: sent with the text, OpenCode reads the pair
  // as a paste and does not act on it.
  await io.sendKeys(ENTER);
  return true;
}

/** Chooses the model, then deals with the variant picker OpenCode may open after it. */
async function pickModel(io: SelectionIo, plan: SelectionPlan): Promise<SelectionOutcome> {
  const outcome = { agent: false, model: false, variant: false };
  if (!plan.modelQuery) return outcome;
  outcome.model = await pick(io, OPEN_MODEL_PICKER, MODEL_PICKER_TITLE, plan.modelQuery);
  if (!outcome.model || !plan.modelHasVariants) return outcome;
  const opened = await io.feed.waitFor(VARIANT_PICKER_TITLE, VARIANT_AUTO_OPEN_MS);
  if (opened && plan.variant) {
    outcome.variant = await search(io, plan.variant);
  } else if (opened) {
    // No variant was asked for: keep the model's default.
    await io.sendKeys(ESCAPE);
  } else if (plan.variant) {
    outcome.variant = await pickVariantFromPalette(io, plan.variant);
  }
  return outcome;
}

/** Reaches the variant picker through the command palette when it did not open itself. */
async function pickVariantFromPalette(io: SelectionIo, variant: string): Promise<boolean> {
  if (io.remainingMs() < 2 * STEP_COST_MS) return false;
  if (!(await pick(io, OPEN_COMMAND_PALETTE, COMMAND_PALETTE_TITLE, VARIANT_COMMAND))) return false;
  if (!(await io.feed.waitFor(VARIANT_PICKER_TITLE, PICKER_TIMEOUT_MS))) {
    await io.sendKeys(ESCAPE);
    return false;
  }
  return search(io, variant);
}

/**
 * Applies a plan to an OpenCode v2 TUI that is on its start screen. The agent
 * goes first: an agent can carry its own model, which choosing it would
 * otherwise put back over the model just selected.
 */
export async function runSelectionPlan(
  session: SelectionSession,
  plan: SelectionPlan,
): Promise<SelectionOutcome> {
  if (!(await session.feed.waitFor(HOME_HINT, HOME_TIMEOUT_MS))) {
    return { agent: false, model: false, variant: false };
  }
  const deadline = session.now() + BUDGET_MS;
  const io: SelectionIo = { ...session, remainingMs: () => deadline - session.now() };
  const agent = plan.agent
    ? await pick(io, OPEN_AGENT_PICKER, AGENT_PICKER_TITLE, plan.agent)
    : false;
  // The agent picker closing redraws the start screen; let it settle first.
  if (agent) await io.sleep(SEARCH_SETTLE_MS);
  return { ...(await pickModel(io, plan)), agent };
}
