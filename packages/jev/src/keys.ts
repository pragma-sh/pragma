/**
 * Everything a synthetic `KeyboardEvent` needs to look like a real keystroke.
 *
 * `keyCode` is included because xterm decides what a key sends from the legacy
 * `keyCode`, not from `key`: a synthetic Enter with `keyCode` 0 reaches the
 * terminal as nothing at all.
 */
export interface KeyStroke {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type Modifier = "ctrlKey" | "metaKey" | "altKey" | "shiftKey";

const MODIFIERS: Record<string, Modifier> = {
  ctrl: "ctrlKey",
  control: "ctrlKey",
  meta: "metaKey",
  cmd: "metaKey",
  command: "metaKey",
  super: "metaKey",
  alt: "altKey",
  option: "altKey",
  opt: "altKey",
  shift: "shiftKey",
};

/** Named keys: `[key, code, keyCode]`, looked up case-insensitively. */
const NAMED: Record<string, [string, string, number]> = {
  enter: ["Enter", "Enter", 13],
  return: ["Enter", "Enter", 13],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  space: [" ", "Space", 32],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};

const PUNCTUATION: Record<string, [string, number]> = {
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "`": ["Backquote", 192],
};

function baseKey(name: string): [string, string, number] {
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  const fn = /^f([1-9]|1[0-2])$/i.exec(name);
  if (fn) return [`F${fn[1]}`, `F${fn[1]}`, 111 + Number(fn[1])];
  if (name.length === 1) {
    if (/[a-z]/i.test(name))
      return [name, `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
    if (/[0-9]/.test(name)) return [name, `Digit${name}`, name.charCodeAt(0)];
    const punctuation = PUNCTUATION[name];
    if (punctuation) return [name, punctuation[0], punctuation[1]];
  }
  throw new Error(`unknown key "${name}"`);
}

/**
 * Parses a chord such as `Enter`, `Meta+t`, `ctrl+c`, or `Cmd+Shift+P`.
 * A `+` key itself is written `Shift+=` or as the last segment (`Meta++`).
 */
export function parseKeyCombo(combo: string): KeyStroke {
  const trimmed = combo.trim();
  if (!trimmed) throw new Error("empty key combo");
  const parts = trimmed.endsWith("++")
    ? [...trimmed.slice(0, -2).split("+").filter(Boolean), "+"]
    : trimmed.split("+");
  const name = parts.pop()!;
  const stroke: KeyStroke = {
    key: "",
    code: "",
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  for (const part of parts) {
    const modifier = MODIFIERS[part.trim().toLowerCase()];
    if (!modifier) throw new Error(`unknown modifier "${part}" in "${combo}"`);
    stroke[modifier] = true;
  }
  const [key, code, keyCode] = name === "+" ? ["+", "Equal", 187] : baseKey(name.trim());
  stroke.key = stroke.shiftKey && key.length === 1 ? key.toUpperCase() : key;
  stroke.code = code;
  stroke.keyCode = keyCode;
  return stroke;
}

/** Parses a space-separated sequence of chords, e.g. `"Escape Meta+k"`. */
export function parseKeySequence(sequence: string): KeyStroke[] {
  return sequence.trim().split(/\s+/).filter(Boolean).map(parseKeyCombo);
}
