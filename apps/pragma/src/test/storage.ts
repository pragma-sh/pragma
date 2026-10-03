/**
 * Installs an in-memory `window.localStorage` for the calling test file.
 *
 * The jsdom environment here exposes no usable `localStorage`, so code that
 * persists through it reads and writes nothing unless a test provides one.
 */
export function installMemoryLocalStorage(): void {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}
