#!/usr/bin/env bun
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  loadSession,
  newSession,
  recordAnswer,
  runSession,
  runsRoot,
  type Session,
  type VisionMode,
} from "./agent.ts";
import { drainLogs, evaluate, liveInstances, resolveInstance, type DevInstance } from "./bridge.ts";
import { parseKeyCombo, parseKeySequence } from "./keys.ts";
import { pressChords } from "./menu.ts";
import { chat, userMessage } from "./model.ts";
import {
  click,
  hover,
  pressKeys,
  readTerminals,
  renderSnapshot,
  scroll,
  selectOption,
  snapshot,
  typeText,
  type Target,
  type TerminalEntry,
} from "./page.ts";
import { captureWindow, encodeForModel } from "./screenshot.ts";

const USAGE = `jev — drive the running Pragma dev app like a person would

Agent (Jev decides each step):
  jev run "<goal>" [--input name=value]... [--steps 25] [--vision auto|always|never]
  jev run --resume <run-id> --answer "<text>"      continue a run that asked a question
  jev look "<question>"                            screenshot + screen text, answered by Jev

Direct control (indexes come from the latest \`jev snapshot\`):
  jev snapshot [--json]                            interactive elements, terminals, visible text
  jev click <index|css> [--right] [--double]       also: jev click --at x,y
  jev hover <index|css>
  jev type "<text>" [--into <index|css>] [--enter]
  jev key "<chords>"                               e.g. "Enter", "Meta+t", "Control+c Escape"
  jev scroll <up|down|left|right> [--amount 3] [--on <index|css>]
  jev select <index|css> "<option>"
  jev terminal read [--full] [--tab <id>]          text of the visible terminal(s)
  jev terminal run "<command>" [--wait 1500]       click into the terminal, type, Enter, read back
  jev screenshot [-o file.png] [--no-raise]        PNG of the app window; prints the path
  jev eval "<js>" | --file script.js               evaluate in the webview
  jev logs                                         drain buffered Rust log lines
  jev instances                                    list running dev instances

Global: --pid <n> selects a dev instance (default: the one built from this checkout).`;

const options = {
  pid: { type: "string" },
  input: { type: "string", multiple: true },
  steps: { type: "string" },
  vision: { type: "string" },
  settle: { type: "string" },
  resume: { type: "string" },
  answer: { type: "string" },
  json: { type: "boolean" },
  right: { type: "boolean" },
  double: { type: "boolean" },
  at: { type: "string" },
  into: { type: "string" },
  enter: { type: "boolean" },
  amount: { type: "string" },
  on: { type: "string" },
  full: { type: "boolean" },
  tab: { type: "string" },
  wait: { type: "string" },
  output: { type: "string", short: "o" },
  "no-raise": { type: "boolean" },
  file: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<
  typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>["values"];

class UsageError extends Error {
  override name = "UsageError";
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** `12` is a snapshot index; anything else is a CSS selector. */
export function parseTarget(value: string | undefined): Target {
  if (value === undefined) return {};
  return /^\d+$/.test(value) ? { index: Number(value) } : { selector: value };
}

function requireTarget(value: string | undefined, command: string): Target {
  if (!value) throw new UsageError(`${command} needs an <index|css> target`);
  return parseTarget(value);
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new UsageError(`--${name} must be a non-negative integer`);
  return parsed;
}

/** Parses repeated `--input name=value` flags. */
export function parseInputs(raw: string[] | undefined): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new UsageError(`--input expects name=value, got "${entry}"`);
    inputs[entry.slice(0, at).trim()] = entry.slice(at + 1);
  }
  return inputs;
}

function visionMode(value: string | undefined): VisionMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "always" || value === "never") return value;
  throw new UsageError("--vision must be auto, always, or never");
}

function report(session: Session, json: boolean): number {
  const codes = { done: 0, fail: 1, waiting: 2, out_of_steps: 3, running: 1 } as const;
  if (json) {
    print(session);
    return codes[session.status];
  }
  const lines = [`\njev ${session.status.replace(/_/g, " ")} after ${session.step} steps`];
  if (session.report) lines.push(`report: ${session.report}`);
  if (session.status === "waiting") {
    lines.push(
      `question: ${session.question}`,
      `resume:   jev run --resume ${session.id} --answer "<your answer>"`,
    );
  }
  if (session.status === "out_of_steps")
    lines.push(`continue: jev run --resume ${session.id} [--steps N]`);
  if (session.finalScreenshot) lines.push(`screenshot: ${session.finalScreenshot}`);
  lines.push(`run folder: ${session.dir}`);
  print(lines.join("\n"));
  return codes[session.status];
}

async function commandRun(positionals: string[], flags: Flags): Promise<number> {
  const runOptions = {
    maxSteps: int(flags.steps, 25, "steps"),
    vision: visionMode(flags.vision),
    settleMs: int(flags.settle, 400, "settle"),
    log,
  };
  let session: Session;
  if (flags.resume) {
    session = loadSession(flags.resume);
    Object.assign(session.inputs, parseInputs(flags.input));
    if (session.status === "waiting") {
      if (!flags.answer)
        throw new UsageError(`run ${session.id} is waiting for an answer: --answer "<text>"`);
      recordAnswer(session, flags.answer);
    } else if (flags.answer) {
      recordAnswer(session, flags.answer);
    }
    session.status = "running";
  } else {
    const goal = positionals.join(" ").trim();
    if (!goal) throw new UsageError('run needs a goal: jev run "<goal>"');
    session = newSession(goal, parseInputs(flags.input));
  }
  const instance = await instanceFor(flags);
  log(`jev → dev instance pid ${instance.pid} · run ${session.id}`);
  log(`goal: ${session.goal}`);
  return report(await runSession(instance, session, runOptions), Boolean(flags.json));
}

async function commandLook(positionals: string[], flags: Flags): Promise<number> {
  const question =
    positionals.join(" ").trim() || "Describe what is on screen and anything that looks wrong.";
  const instance = await instanceFor(flags);
  const path = resolve(flags.output ?? join(runsRoot(), `look-${Date.now()}.png`));
  await captureWindow(instance, path, { raise: !flags["no-raise"] });
  const screen = renderSnapshot(await snapshot(instance));
  const answer = await chat(
    [
      {
        role: "system",
        content:
          "You inspect screenshots of the Pragma desktop app for a developer verifying their work. The large dark areas are xterm terminals drawn on a canvas; their text is also given. Answer the question precisely and concretely, quoting visible text. Say plainly when something looks broken, misaligned, clipped, or unexpected.",
      },
      userMessage(`QUESTION: ${question}\n\nSCREEN TEXT:\n${screen}`, [
        encodeForModel(path, `${path}.small.png`),
      ]),
    ],
    {},
  );
  print(`${answer.trim()}\n\nscreenshot: ${path}`);
  return 0;
}

function renderTerminals(terminals: TerminalEntry[]): string {
  if (terminals.length === 0) return "(no visible terminal)";
  return terminals
    .map(
      (terminal) =>
        `── terminal ${terminal.tabId}${terminal.focused ? " (focused)" : ""}${terminal.visible ? "" : " (hidden)"} ${terminal.cols}x${terminal.rows}\n${terminal.lines.join("\n")}`,
    )
    .join("\n\n");
}

async function commandTerminal(positionals: string[], flags: Flags): Promise<number> {
  const [sub = "read", ...rest] = positionals;
  const instance = await instanceFor(flags);
  if (sub === "read") {
    const terminals = (await readTerminals(instance, Boolean(flags.full))).filter(
      (terminal) => !flags.tab || terminal.tabId === flags.tab,
    );
    print(flags.json ? terminals : renderTerminals(terminals));
    return 0;
  }
  if (sub === "run") {
    const command = rest.join(" ");
    if (!command)
      throw new UsageError('terminal run needs a command: jev terminal run "<command>"');
    const snap = await snapshot(instance);
    const terminal =
      snap.terminals.find((entry) => entry.focused) ??
      snap.terminals.find((entry) => entry.visible);
    if (!terminal || terminal.index === undefined) {
      throw new UsageError(
        "no terminal is visible; open a terminal tab first (or let `jev run` do it)",
      );
    }
    const enter = parseKeyCombo("Enter");
    await click(instance, { index: terminal.index });
    await typeText(instance, command, enter);
    await pressKeys(instance, [enter]);
    await new Promise((done) => setTimeout(done, int(flags.wait, 1500, "wait")));
    const after = (await readTerminals(instance, false)).filter(
      (entry) => entry.tabId === terminal.tabId,
    );
    print(renderTerminals(after));
    return 0;
  }
  throw new UsageError(`unknown terminal command "${sub}" (read | run)`);
}

async function instanceFor(flags: Flags): Promise<DevInstance> {
  return resolveInstance(flags.pid === undefined ? undefined : int(flags.pid, 0, "pid"));
}

function clickTarget(positionals: string[], flags: Flags): Target {
  if (!flags.at) return requireTarget(positionals[0], "click");
  const [x, y] = flags.at.split(",").map(Number);
  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
    throw new UsageError("--at expects x,y");
  }
  return { x, y };
}

function scrollDirection(value: string | undefined): "up" | "down" | "left" | "right" {
  const direction = value ?? "down";
  if (direction === "up" || direction === "down" || direction === "left" || direction === "right")
    return direction;
  throw new UsageError("scroll up|down|left|right");
}

async function typeCommand(
  instance: DevInstance,
  positionals: string[],
  flags: Flags,
): Promise<unknown> {
  const enter = parseKeyCombo("Enter");
  const typed = await typeText(instance, positionals.join(" "), enter, parseTarget(flags.into));
  if (flags.enter) await pressKeys(instance, [enter]);
  return typed;
}

async function screenshotCommand(instance: DevInstance, flags: Flags): Promise<string> {
  const path = resolve(flags.output ?? join(runsRoot(), `screenshot-${Date.now()}.png`));
  const via = await captureWindow(instance, path, { raise: !flags["no-raise"] });
  log(`captured via ${via}`);
  return path;
}

function evalSource(positionals: string[], flags: Flags): string {
  const js = flags.file ? readFileSync(flags.file, "utf8") : positionals.join(" ");
  if (!js.trim()) throw new UsageError('eval needs JavaScript: jev eval "<js>" or --file');
  return js;
}

type DirectCommand = (
  instance: DevInstance,
  positionals: string[],
  flags: Flags,
) => Promise<unknown>;

/** Single-shot commands: each returns what to print. */
const DIRECT: Record<string, DirectCommand> = {
  snapshot: async (instance, _positionals, flags) => {
    const snap = await snapshot(instance);
    return flags.json ? snap : renderSnapshot(snap);
  },
  click: (instance, positionals, flags) =>
    click(instance, {
      ...clickTarget(positionals, flags),
      button: flags.right ? "right" : "left",
      double: flags.double,
    }),
  hover: (instance, positionals) => hover(instance, requireTarget(positionals[0], "hover")),
  type: typeCommand,
  key: (instance, positionals) => pressChords(instance, parseKeySequence(positionals.join(" "))),
  scroll: (instance, positionals, flags) =>
    scroll(
      instance,
      scrollDirection(positionals[0]),
      int(flags.amount, 3, "amount"),
      parseTarget(flags.on),
    ),
  select: (instance, [target, ...value]) =>
    selectOption(instance, value.join(" "), requireTarget(target, "select")),
  screenshot: (instance, _positionals, flags) => screenshotCommand(instance, flags),
  eval: (instance, positionals, flags) => evaluate(instance, evalSource(positionals, flags)),
  logs: (instance) => drainLogs(instance),
};

async function commandDirect(
  command: string,
  positionals: string[],
  flags: Flags,
): Promise<number> {
  const handler = DIRECT[command];
  if (!handler) throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  print(await handler(await instanceFor(flags), positionals, flags));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values: flags, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (!command || flags.help) {
    print(USAGE);
    return command ? 0 : 1;
  }
  switch (command) {
    case "run":
      return commandRun(rest, flags);
    case "look":
      return commandLook(rest, flags);
    case "terminal":
      return commandTerminal(rest, flags);
    case "instances": {
      const instances = await liveInstances();
      print(
        instances.length
          ? instances.map((i) => `pid ${i.pid}  port ${i.port}  ${i.exe ?? "?"}`).join("\n")
          : "no running dev instances",
      );
      return 0;
    }
    default:
      return commandDirect(command, rest, flags);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    log(`jev: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError ? 64 : 1;
  }
}
