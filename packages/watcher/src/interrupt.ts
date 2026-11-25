/**
 * The keys an interrupt writes into an agent's terminal.
 *
 * Escape is what most agent TUIs cancel a turn with, so it is the default. It
 * is not universal: Grok binds Escape to scrollback and cancels on Ctrl+C, so
 * an Escape there scrolled the view while the turn ran on. A watcher names its
 * own keys with `WatcherDefinition.interruptKeys`.
 */
export const DEFAULT_INTERRUPT_KEYS = "\x1b";

/** The interrupt keys for a watcher: its own when it declares any, else Escape. */
export function interruptKeysFor(watcher: { interruptKeys?: unknown }): string {
  const configured = watcher.interruptKeys;
  return typeof configured === "string" && configured.length > 0
    ? configured
    : DEFAULT_INTERRUPT_KEYS;
}
