/// <reference types="node" />

import { readFileSync } from "node:fs";

import { constants } from "@pragma-sh/constants";

import { evaluate, type BridgeToken } from "./bridge.ts";
import type { KeyStroke } from "./keys.ts";

const AGENT_SOURCE = readFileSync(new URL("./page-agent.js", import.meta.url), "utf8");
const COMMAND_PLACEHOLDER = "__JEV_COMMAND__";

/** One interactive element from a snapshot. */
export interface ElementEntry {
  index: number;
  kind: "element";
  tag: string;
  label: string;
  role?: string;
  type?: string;
  editable?: boolean;
  value?: string;
  options?: string[];
  expanded?: string;
  selected?: string;
  checked?: string | boolean;
  pressed?: string;
  current?: string;
  state?: string;
  disabled?: boolean;
  tour?: string;
  focused?: boolean;
  covered?: boolean;
  box: [number, number, number, number];
}

/** One visible terminal, read through the dev-only xterm hook. */
export interface TerminalEntry {
  index?: number;
  kind?: "terminal";
  tabId: string;
  visible: boolean;
  focused: boolean;
  cols: number;
  rows: number;
  cursor: [number, number];
  lines: string[];
  box?: [number, number, number, number];
}

/** Everything a person could see and reach in the window right now. */
export interface Snapshot {
  title: string;
  url: string;
  viewport: [number, number];
  windowFocused: boolean;
  focused: string;
  dialogs: string[];
  elements: ElementEntry[];
  terminals: TerminalEntry[];
  texts: string[];
}

/** Where an action lands: a snapshot index, a CSS selector, or viewport coordinates. */
export interface Target {
  index?: number;
  selector?: string;
  x?: number;
  y?: number;
}

/** Runs one page-agent op in the dev webview. */
async function run<T>(instance: BridgeToken, op: string, args: object = {}): Promise<T> {
  const command = { op, hookGlobal: constants.bench.hookGlobal, ...args };
  const js = AGENT_SOURCE.replace(COMMAND_PLACEHOLDER, () => JSON.stringify(command));
  return (await evaluate(instance, js)) as T;
}

/** Indexes every visible interactive element and reads the visible terminals. */
export function snapshot(instance: BridgeToken): Promise<Snapshot> {
  return run(instance, "snapshot");
}

/** Clicks like a mouse: move, press, release, click — at the element's visible centre. */
export function click(
  instance: BridgeToken,
  target: Target & { button?: "left" | "right"; double?: boolean } & Partial<KeyStroke>,
): Promise<unknown> {
  return run(instance, "click", target);
}

/** Moves the pointer over an element without pressing. */
export function hover(instance: BridgeToken, target: Target): Promise<unknown> {
  return run(instance, "hover", target);
}

/** Types text into the focused element (clicking `target` first when given). */
export function typeText(
  instance: BridgeToken,
  text: string,
  enter: KeyStroke,
  target: Target = {},
): Promise<unknown> {
  return run(instance, "type", { ...target, text, enter });
}

/** Presses key chords on the focused element. */
export function pressKeys(instance: BridgeToken, strokes: KeyStroke[]): Promise<unknown> {
  return run(instance, "keys", { strokes });
}

/** Scrolls with a wheel gesture over `target` (or the middle of the window). */
export function scroll(
  instance: BridgeToken,
  direction: "up" | "down" | "left" | "right",
  amount: number,
  target: Target = {},
): Promise<unknown> {
  return run(instance, "scroll", { ...target, direction, amount });
}

/** Picks an option of a native `<select>`. */
export function selectOption(
  instance: BridgeToken,
  value: string,
  target: Target,
): Promise<unknown> {
  return run(instance, "select", { ...target, value });
}

/** Reads terminal text; `full` includes scrollback and hidden tabs. */
export function readTerminals(instance: BridgeToken, full: boolean): Promise<TerminalEntry[]> {
  return run(instance, "terminals", { full });
}

const FLAGS: (keyof ElementEntry)[] = [
  "expanded",
  "selected",
  "checked",
  "pressed",
  "current",
  "state",
  "disabled",
  "focused",
  "covered",
];

function renderFlag(entry: ElementEntry, flag: keyof ElementEntry): string | null {
  const value = entry[flag];
  if (value === undefined || value === false) return null;
  return value === true ? flag : `${flag}=${String(value)}`;
}

function renderElement(entry: ElementEntry): string {
  const kind = entry.role ?? (entry.type ? `${entry.tag}[${entry.type}]` : entry.tag);
  const hasValue = entry.editable || entry.value !== undefined;
  const parts = [
    `[${entry.index}] ${kind} "${entry.label}"`,
    hasValue ? `value="${entry.value ?? ""}"` : null,
    entry.options ? `options=${JSON.stringify(entry.options)}` : null,
    entry.tour ? `tour=${entry.tour}` : null,
    ...FLAGS.map((flag) => renderFlag(entry, flag)),
    `@${entry.box[0]},${entry.box[1]} ${entry.box[2]}x${entry.box[3]}`,
  ];
  return parts.filter((part) => part !== null).join(" ");
}

function renderTerminal(terminal: TerminalEntry): string {
  const header = `[${terminal.index ?? "-"}] TERMINAL (canvas) tab=${terminal.tabId} ${terminal.cols}x${terminal.rows}${terminal.focused ? " focused — keystrokes go to the shell" : " — click it to type into it"}`;
  const body = terminal.lines.length
    ? terminal.lines.map((line) => `    │ ${line}`).join("\n")
    : "    │ (blank)";
  return `${header}\n${body}`;
}

/** Renders a snapshot as the compact text jev reads (and a person can skim). */
export function renderSnapshot(snap: Snapshot): string {
  const lines = [
    `window: "${snap.title}" ${snap.viewport[0]}x${snap.viewport[1]}${snap.windowFocused ? "" : " (window not focused)"}`,
    `focused: ${snap.focused}`,
  ];
  if (snap.dialogs.length)
    lines.push(`open dialogs: ${snap.dialogs.map((d) => `"${d}"`).join(", ")}`);
  lines.push("", "interactive elements:");
  lines.push(...snap.elements.map(renderElement));
  if (snap.terminals.length) {
    lines.push("", "terminals:");
    lines.push(...snap.terminals.map(renderTerminal));
  }
  if (snap.texts.length) {
    lines.push("", "other visible text:");
    lines.push(...snap.texts.map((text) => `  ${text}`));
  }
  return lines.join("\n");
}
