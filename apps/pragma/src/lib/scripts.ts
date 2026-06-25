import type { RunScriptEntry, RunScriptNode } from "@pragma/constants";

export type RunScriptLayoutTemplate =
  | { kind: "pane"; commandIndex: number }
  | {
      kind: "split";
      direction: "horizontal" | "vertical";
      children: [RunScriptLayoutTemplate, RunScriptLayoutTemplate];
    };

export interface PlannedRunScriptItem {
  commandIndexes: number[];
  layout: RunScriptLayoutTemplate | null;
}

export interface PlannedRunScripts {
  commands: string[];
  items: PlannedRunScriptItem[];
}

/** Flattens interactive script entries into commands plus split templates. */
export function planInteractiveScripts(
  entries: RunScriptEntry[],
  label: string,
): PlannedRunScripts {
  const commands: string[] = [];
  const items = entries.map((entry, index) => {
    const before = commands.length;
    const path = `${label}[${index}]`;
    if (typeof entry === "string") {
      const commandIndex = pushCommand(commands, entry, path);
      return { commandIndexes: [commandIndex], layout: null };
    }
    const layout = planNode(entry, commands, path);
    return { commandIndexes: range(before, commands.length), layout };
  });
  return { commands, items };
}

/** Flattens interactive run-script entries into commands plus split templates. */
export function planRunScripts(entries: RunScriptEntry[]): PlannedRunScripts {
  return planInteractiveScripts(entries, "run");
}

/** Flattens interactive build-script entries into commands plus split templates. */
export function planBuildScripts(entries: RunScriptEntry[]): PlannedRunScripts {
  return planInteractiveScripts(entries, "build");
}

function planNode(node: RunScriptNode, commands: string[], path: string): RunScriptLayoutTemplate {
  if (typeof node === "string") {
    return { kind: "pane", commandIndex: pushCommand(commands, node, path) };
  }
  if (!isRecord(node)) {
    throw new Error(`${path} must be a command string or split object`);
  }
  const keys = Object.keys(node);
  const hasHorizontal = keys.includes("left") || keys.includes("right");
  const hasVertical = keys.includes("top") || keys.includes("bottom");
  if (hasHorizontal === hasVertical) {
    throw new Error(`${path} must use exactly one split axis: left/right or top/bottom`);
  }
  if (hasHorizontal) {
    ensureExactKeys(keys, ["left", "right"], path);
    return {
      kind: "split",
      direction: "horizontal",
      children: [
        planNode(node.left as RunScriptNode, commands, `${path}.left`),
        planNode(node.right as RunScriptNode, commands, `${path}.right`),
      ],
    };
  }
  ensureExactKeys(keys, ["top", "bottom"], path);
  return {
    kind: "split",
    direction: "vertical",
    children: [
      planNode(node.top as RunScriptNode, commands, `${path}.top`),
      planNode(node.bottom as RunScriptNode, commands, `${path}.bottom`),
    ],
  };
}

function pushCommand(commands: string[], command: string, path: string): number {
  if (command.trim().length === 0) {
    throw new Error(`${path} must not be empty`);
  }
  commands.push(command);
  return commands.length - 1;
}

function ensureExactKeys(keys: string[], expected: [string, string], path: string) {
  for (const key of keys) {
    if (!expected.includes(key)) {
      throw new Error(`${path} has unknown key ${key}`);
    }
  }
  for (const key of expected) {
    if (!keys.includes(key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
