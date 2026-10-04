/// <reference types="node" />
/* oxlint-disable no-await-in-loop -- an agent loop is sequential by nature: each
   step reads the screen the previous action produced. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { EvalError, type DevInstance } from "./bridge.ts";
import { parseKeyCombo, parseKeySequence } from "./keys.ts";
import { pressChords } from "./menu.ts";
import { chat, parseJsonReply, userMessage } from "./model.ts";
import {
  click,
  hover,
  pressKeys,
  renderSnapshot,
  scroll,
  selectOption,
  snapshot,
  typeText,
  type Snapshot,
} from "./page.ts";
import {
  ACTIONS,
  DECISION_SCHEMA,
  SYSTEM_PROMPT,
  stepPrompt,
  type Decision,
  type HistoryEntry,
} from "./prompt.ts";
import { captureWindow, encodeForModel, raiseWindow } from "./screenshot.ts";

/** Longest single `wait` jev may ask for. */
const MAX_WAIT_MS = 10_000;

/** When jev gets a screenshot with its screen text. */
export type VisionMode = "auto" | "always" | "never";

/** How a run ended. `waiting` means jev asked a question and the run can be resumed. */
export type RunStatus = "running" | "done" | "fail" | "waiting" | "out_of_steps";

/** Everything needed to continue a run later, persisted as `session.json`. */
export interface Session {
  id: string;
  dir: string;
  goal: string;
  inputs: Record<string, string>;
  history: HistoryEntry[];
  step: number;
  status: RunStatus;
  question?: string;
  report?: string;
  finalScreenshot?: string;
}

/** Options for one `jev run` invocation. */
export interface RunOptions {
  maxSteps: number;
  vision: VisionMode;
  settleMs: number;
  log: (line: string) => void;
}

/** Root directory for run folders. */
export function runsRoot(): string {
  return process.env.JEV_RUNS_DIR ?? join(tmpdir(), "pragma-jev", "runs");
}

/** Starts a fresh session on disk. */
export function newSession(goal: string, inputs: Record<string, string>): Session {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const id = `${stamp}-${randomBytes(3).toString("hex")}`;
  const dir = join(runsRoot(), id);
  mkdirSync(dir, { recursive: true });
  return { id, dir, goal, inputs, history: [], step: 0, status: "running" };
}

/** Loads a session by id (or by its folder path). */
export function loadSession(idOrPath: string): Session {
  const dir = existsSync(join(idOrPath, "session.json")) ? idOrPath : join(runsRoot(), idOrPath);
  const file = join(dir, "session.json");
  if (!existsSync(file)) throw new Error(`no jev run "${idOrPath}" (looked in ${dir})`);
  return JSON.parse(readFileSync(file, "utf8")) as Session;
}

function save(session: Session): void {
  writeFileSync(join(session.dir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
}

const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** Validates the model's JSON into a {@link Decision}, or throws with what was wrong. */
export function toDecision(raw: Record<string, unknown>): Decision {
  const action = raw.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
  const direction = raw.direction;
  return {
    thought: str(raw.thought) ?? "",
    action: action as Decision["action"],
    index: num(raw.index),
    text: str(raw.text),
    keys: str(raw.keys),
    direction:
      direction === "up" || direction === "down" || direction === "left" || direction === "right"
        ? direction
        : null,
    amount: num(raw.amount),
    enter: typeof raw.enter === "boolean" ? raw.enter : null,
  };
}

/** A short human-readable form of a decision for logs and history. */
export function describeDecision(decision: Decision, snap: Snapshot | null): string {
  const target = (() => {
    if (decision.index === null || !snap)
      return decision.index === null ? "" : ` [${decision.index}]`;
    const element = snap.elements.find((entry) => entry.index === decision.index);
    if (element) return ` [${decision.index}] ${element.role ?? element.tag} "${element.label}"`;
    const terminal = snap.terminals.find((entry) => entry.index === decision.index);
    return terminal ? ` [${decision.index}] terminal` : ` [${decision.index}]`;
  })();
  switch (decision.action) {
    case "type":
      return `type${target} ${JSON.stringify(decision.text ?? "")}${decision.enter ? " + Enter" : ""}`;
    case "key":
      return `key ${decision.keys ?? ""}`;
    case "scroll":
      return `scroll${target} ${decision.direction ?? "down"} ${decision.amount ?? 3}`;
    case "select":
      return `select${target} ${JSON.stringify(decision.text ?? "")}`;
    case "wait":
      return `wait ${decision.amount ?? 1000}ms`;
    case "ask":
    case "done":
    case "fail":
      return decision.action;
    default:
      return `${decision.action}${target}`;
  }
}

function requireIndex(decision: Decision): number {
  if (decision.index === null) throw new Error(`${decision.action} needs an index`);
  return decision.index;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENTER = parseKeyCombo("Enter");

const optionalTarget = (decision: Decision) =>
  decision.index === null ? {} : { index: decision.index };

const clickWith =
  (extra: { double?: boolean; button?: "left" | "right" }) =>
  (instance: DevInstance, decision: Decision) =>
    click(instance, { index: requireIndex(decision), ...extra });

async function typeStep(instance: DevInstance, decision: Decision): Promise<unknown> {
  const typed = await typeText(instance, decision.text ?? "", ENTER, optionalTarget(decision));
  if (!decision.enter) return typed;
  await pressKeys(instance, [ENTER]);
  return { ...(typed as object), pressed: "Enter" };
}

async function waitStep(_instance: DevInstance, decision: Decision): Promise<string> {
  const ms = Math.min(Math.max(decision.amount ?? 1000, 100), MAX_WAIT_MS);
  await sleep(ms);
  return `waited ${ms}ms`;
}

/** How each page-touching action is carried out. */
const PERFORMERS: Partial<
  Record<Decision["action"], (instance: DevInstance, decision: Decision) => Promise<unknown>>
> = {
  click: clickWith({}),
  double_click: clickWith({ double: true }),
  right_click: clickWith({ button: "right" }),
  hover: (instance, decision) => hover(instance, { index: requireIndex(decision) }),
  type: typeStep,
  key: (instance, decision) => pressChords(instance, parseKeySequence(decision.keys ?? "")),
  scroll: (instance, decision) =>
    scroll(instance, decision.direction ?? "down", decision.amount ?? 3, optionalTarget(decision)),
  select: (instance, decision) =>
    selectOption(instance, decision.text ?? "", { index: requireIndex(decision) }),
  wait: waitStep,
};

/** Performs one decision against the page and returns a short result line. */
async function perform(instance: DevInstance, decision: Decision): Promise<string> {
  const performer = PERFORMERS[decision.action];
  if (!performer) return "";
  const result = await performer(instance, decision);
  return typeof result === "string" ? result : JSON.stringify(result);
}

async function decide(
  session: Session,
  options: RunOptions,
  screen: string,
  image: string | null,
): Promise<Decision> {
  const prompt = stepPrompt({
    goal: session.goal,
    inputs: session.inputs,
    history: session.history,
    step: session.step,
    maxSteps: options.maxSteps,
    screen,
    screenshotAttached: image !== null,
  });
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    userMessage(prompt, image ? [image] : []),
  ];
  let lastError: unknown;
  // A malformed answer gets one retry before the run gives up on it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return toDecision(parseJsonReply(await chat(messages, { schema: DECISION_SCHEMA })));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function promptUser(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await readline.question(`\njev asks: ${question}\n> `)).trim() || null;
  } finally {
    readline.close();
  }
}

async function finalScreenshot(
  instance: DevInstance,
  session: Session,
  log: (line: string) => void,
): Promise<void> {
  const path = join(session.dir, "final.png");
  try {
    await captureWindow(instance, path);
    session.finalScreenshot = path;
  } catch (error) {
    log(`(final screenshot unavailable: ${(error as Error).message.split("\n")[0]})`);
  }
}

/** Records an answer from the user so the next step sees it in HISTORY. */
export function recordAnswer(session: Session, answer: string): void {
  session.history.push({
    step: session.step,
    action: "ask",
    thought: session.question ?? "",
    result: `the user answered: ${answer}`,
  });
  session.question = undefined;
  session.status = "running";
}

interface Observation {
  snap: Snapshot | null;
  screen: string;
  image: string | null;
}

/** Reads the screen, plus a screenshot for the model when one is wanted. */
async function observe(
  instance: DevInstance,
  session: Session,
  tag: string,
  withImage: boolean,
): Promise<Observation> {
  let snap: Snapshot | null = null;
  let screen: string;
  try {
    snap = await snapshot(instance);
    screen = renderSnapshot(snap);
  } catch (error) {
    // A navigation or reload swallows the eval; the next step usually reads fine.
    screen = `(could not read the screen: ${(error as Error).message})`;
  }
  if (!withImage) return { snap, screen, image: null };
  const shot = join(session.dir, `step-${tag}.png`);
  try {
    await captureWindow(instance, shot);
    return {
      snap,
      screen,
      image: encodeForModel(shot, join(session.dir, `step-${tag}.small.png`)),
    };
  } catch (error) {
    return {
      snap,
      screen: `${screen}\n(screenshot unavailable: ${(error as Error).message.split("\n")[0]})`,
      image: null,
    };
  }
}

/** What the loop does after a step: keep going (maybe with a screenshot), or stop. */
type StepOutcome = "next" | "next-with-screenshot" | "stop";

async function concludeOrAsk(session: Session, decision: Decision): Promise<StepOutcome> {
  if (decision.action !== "ask") {
    session.status = decision.action === "done" ? "done" : "fail";
    session.report = decision.text ?? decision.thought;
    return "stop";
  }
  session.question = decision.text ?? decision.thought;
  const answer = await promptUser(session.question);
  if (answer === null) {
    session.status = "waiting";
    return "stop";
  }
  recordAnswer(session, answer);
  return "next";
}

async function act(
  instance: DevInstance,
  session: Session,
  decision: Decision,
  label: string,
  options: RunOptions,
): Promise<StepOutcome> {
  if (decision.action === "done" || decision.action === "fail" || decision.action === "ask") {
    return concludeOrAsk(session, decision);
  }
  let result = "screenshot attached to the next step";
  if (decision.action !== "screenshot") {
    try {
      result = await perform(instance, decision);
    } catch (error) {
      const kind = error instanceof EvalError ? "the page rejected it" : "it failed";
      result = `ERROR (${kind}): ${(error as Error).message}`;
    }
    options.log(`         → ${result}`);
  }
  session.history.push({ step: session.step, action: label, thought: decision.thought, result });
  save(session);
  if (decision.action === "screenshot") return "next-with-screenshot";
  await sleep(options.settleMs);
  return "next";
}

/**
 * Runs jev toward the session's goal until it finishes, fails, asks a question
 * nobody can answer interactively, or runs out of steps.
 */
export async function runSession(
  instance: DevInstance,
  session: Session,
  options: RunOptions,
): Promise<Session> {
  raiseWindow(instance.pid);
  let outcome: StepOutcome = "next";
  const limit = session.step + options.maxSteps;
  while (session.step < limit && outcome !== "stop") {
    session.step += 1;
    const tag = String(session.step).padStart(2, "0");
    const withImage =
      options.vision === "always" ||
      (options.vision === "auto" && outcome === "next-with-screenshot");
    const { snap, screen, image } = await observe(instance, session, tag, withImage);
    const decision = await decide(session, options, screen, image);
    const label = describeDecision(decision, snap);
    options.log(`step ${session.step}: ${label} — ${decision.thought}`);
    writeFileSync(
      join(session.dir, `step-${tag}.txt`),
      `${screen}\n\n--- decision ---\n${JSON.stringify(decision, null, 2)}\n`,
    );
    outcome = await act(instance, session, decision, label, options);
  }
  if (session.status === "running") session.status = "out_of_steps";
  if (session.status !== "waiting") await finalScreenshot(instance, session, options.log);
  save(session);
  return session;
}
