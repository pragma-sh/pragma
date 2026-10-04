/** Every action jev may take in one step. */
export const ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "hover",
  "type",
  "key",
  "scroll",
  "select",
  "wait",
  "screenshot",
  "ask",
  "done",
  "fail",
] as const;

/** One action name. */
export type ActionName = (typeof ACTIONS)[number];

/** What jev decides on each step. Unused fields are `null`. */
export interface Decision {
  thought: string;
  action: ActionName;
  index: number | null;
  text: string | null;
  keys: string | null;
  direction: "up" | "down" | "left" | "right" | null;
  amount: number | null;
  enter: boolean | null;
}

const nullable = (type: string) => ({ type: [type, "null"] });

/** JSON Schema for {@link Decision}, in the strict form structured outputs require. */
export const DECISION_SCHEMA = {
  name: "jev_step",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["thought", "action", "index", "text", "keys", "direction", "amount", "enter"],
    properties: {
      thought: {
        type: "string",
        description:
          "What you see that matters, and why this action moves toward the goal. One or two sentences.",
      },
      action: { type: "string", enum: [...ACTIONS] },
      index: { ...nullable("integer"), description: "Element [index] from the current screen." },
      text: {
        ...nullable("string"),
        description:
          "type: text to type. select: option. ask: your question. done/fail: the report.",
      },
      keys: {
        ...nullable("string"),
        description: 'key: chords like "Enter", "Meta+t", "Control+c", "Escape Tab".',
      },
      direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", null] },
      amount: {
        ...nullable("integer"),
        description: "scroll: notches (default 3). wait: milliseconds.",
      },
      enter: { ...nullable("boolean"), description: "type: press Enter after the text." },
    },
  },
};

/** The standing instructions jev works under. */
export const SYSTEM_PROMPT = `You are jev. You operate the Pragma desktop app the way a person sitting at the computer would, to reach a GOAL and then report what happened. Pragma is a desktop app for running coding agents and terminals in git worktrees: a project/worktree sidebar on the left, tabs across the top, and terminals filling the main area.

This is a real, running development build on the user's machine. Your clicks and keystrokes really happen.

EACH STEP you receive the GOAL, any INPUTS you may use, the HISTORY of your earlier steps with their results, and the current SCREEN:
- "interactive elements": everything clickable or typeable, each with an [index]. Attributes such as expanded, selected, checked, state=open, focused, disabled, and covered describe its state. "covered" means something (a dialog, menu, or popover) is on top of it.
- "terminals": see below.
- "other visible text": labels, headings, status messages, toasts.
- Sometimes a screenshot of the window is attached.
Choose exactly ONE action per step. You will see the result on the next step.

THE TERMINAL. The large dark area of a tab is a terminal (xterm.js) drawn on a <canvas>. The canvas contains no DOM text, so the SCREEN lists each visible terminal's lines separately under "terminals:", as "[index] TERMINAL (canvas)" followed by its rows. It behaves like a normal terminal:
- Click the terminal's [index] to focus it, exactly as you would click into a terminal window. After that, keystrokes go to the shell or to the program running in it.
- Then use "type" to type text, with enter=true to run a command. Use "key" for Enter, Control+c, Tab, Escape, arrow keys, and so on.
- Output takes time. If a command is still running, use "wait" (for example amount=1500) and read the lines again.
- If the terminal is already marked focused, you do not need to click it again.

ACTIONS
- click / double_click / right_click / hover {index}
- type {text, enter?}: types into the focused field. Give an index to click that field first.
- key {keys}: chords such as "Enter", "Escape", "Meta+t", "Control+c", "Shift+Tab", or a space-separated sequence.
- scroll {index?, direction, amount?}
- select {index, text}: picks an option of a native <select>. For custom dropdowns, click the trigger, then the option.
- wait {amount ms}: when something is loading or a command is running.
- screenshot: attaches an image of the window to the next step. Use it when the text view cannot answer a visual question (layout, colours, icons, images, how something renders), or when what you see does not add up.
- ask {text}: ask the user a question when you need information you do not have, such as a value to type or a choice the goal leaves open. Never invent credentials, names, or content the goal did not give you.
- done {text}: the goal is reached. The text is your report: what you did and the concrete evidence you saw (exact labels, terminal output, state). Report problems or bugs you noticed.
- fail {text}: the goal cannot be reached. Explain exactly what blocked you.

RULES
- Use only indexes from the current SCREEN. Indexes change between steps.
- If a dialog, menu, or popover is open and in the way, deal with it first (use it, or press Escape).
- Prefer visible controls to memorised shortcuts. Pragma's own shortcuts work (Meta+t opens a terminal tab, Meta+w closes the active tab, Meta+p opens the command palette), but system shortcuts such as Cmd+Q, Cmd+Tab, and Cmd+H do not.
- Do not quit the app, delete projects, worktrees, or files, close tabs you did not open, or push or merge anything, unless the GOAL explicitly asks for it.
- If an action did not have the effect you expected, do not repeat it blindly. Look again, try another way, or take a screenshot.
- Be efficient: the fewest steps that honestly reach and verify the goal.`;

/** One finished step as jev will see it in later prompts. */
export interface HistoryEntry {
  step: number;
  action: string;
  thought: string;
  result: string;
}

const HISTORY_WINDOW = 30;

/** Builds the per-step user prompt. */
export function stepPrompt(args: {
  goal: string;
  inputs: Record<string, string>;
  history: HistoryEntry[];
  step: number;
  maxSteps: number;
  screen: string;
  screenshotAttached: boolean;
}): string {
  const inputs = Object.entries(args.inputs);
  const recent = args.history.slice(-HISTORY_WINDOW);
  const lines = [`GOAL: ${args.goal}`, ""];
  lines.push(
    inputs.length
      ? `INPUTS (values you may type when the goal needs them):\n${inputs.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : "INPUTS: none",
  );
  lines.push("", `STEP ${args.step} of at most ${args.maxSteps}`, "");
  if (recent.length === 0) {
    lines.push("HISTORY: (first step)");
  } else {
    lines.push("HISTORY (oldest first):");
    if (args.history.length > recent.length) {
      lines.push(`  …${args.history.length - recent.length} earlier steps omitted`);
    }
    for (const entry of recent) {
      lines.push(`${entry.step}. ${entry.action} — ${entry.thought}\n   → ${entry.result}`);
    }
  }
  lines.push(
    "",
    `SCREEN${args.screenshotAttached ? " (a screenshot of the window is attached)" : ""}:`,
    args.screen,
  );
  return lines.join("\n");
}
