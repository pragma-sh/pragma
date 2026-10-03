/* oxlint-disable no-await-in-loop -- keystrokes are ordered in time; each must land before the next. */
import { BridgeError, bridgeRequest, type BridgeToken } from "./bridge.ts";
import { parseKeyCombo, type KeyStroke } from "./keys.ts";
import { pressKeys } from "./page.ts";

/** A native menu item and the accelerator that fires it. */
export interface MenuItem {
  id: string;
  accelerator: string;
}

/** Converts a Tauri accelerator (`CmdOrCtrl+Shift+P`) into the stroke it fires on. */
export function acceleratorStroke(accelerator: string, platform: NodeJS.Platform): KeyStroke {
  const primary = platform === "darwin" ? "Meta" : "Control";
  return parseKeyCombo(accelerator.replace(/CmdOrCtrl|CommandOrControl/gi, primary));
}

function sameChord(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.code === b.code &&
    a.metaKey === b.metaKey &&
    a.ctrlKey === b.ctrlKey &&
    a.altKey === b.altKey &&
    a.shiftKey === b.shiftKey
  );
}

/** The menu item a stroke would fire, matched on physical key and modifiers. */
export function menuItemFor(
  stroke: KeyStroke,
  items: MenuItem[],
  platform: NodeJS.Platform,
): MenuItem | null {
  return (
    items.find((item) => sameChord(acceleratorStroke(item.accelerator, platform), stroke)) ?? null
  );
}

async function menuItems(instance: BridgeToken): Promise<MenuItem[]> {
  try {
    return (await bridgeRequest<{ items: MenuItem[] }>(instance, "/menu")).items;
  } catch (error) {
    // An older dev build has no /menu; every chord then goes to the page.
    if (error instanceof BridgeError) return [];
    throw error;
  }
}

/**
 * Presses chords the way the OS would deliver them: a chord bound to a native
 * menu item fires that item (macOS hands such chords to the menu bar, so the
 * page never sees them), and every other chord goes to the focused element.
 */
export async function pressChords(instance: BridgeToken, strokes: KeyStroke[]): Promise<unknown[]> {
  const items = await menuItems(instance);
  const results: unknown[] = [];
  for (const stroke of strokes) {
    const item = menuItemFor(stroke, items, process.platform);
    const result = item
      ? { menu: item.id, ...(await bridgeRequest<object>(instance, "/menu", { id: item.id })) }
      : await pressKeys(instance, [stroke]);
    results.push(result);
  }
  return results;
}
