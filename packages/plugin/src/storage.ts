import { getBridge } from "./bridge";

/** Imperative durable JSON storage scoped to one plugin id. */
export interface PluginStorage {
  get<T>(key: string, initialValue: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Returns an imperative durable-storage client scoped to one plugin id. */
export function storageFor(pluginId: string): PluginStorage {
  return {
    get: <T>(key: string, initialValue: T) => getStoredState(pluginId, key, initialValue),
    set: <T>(key: string, value: T) => setStoredState(pluginId, key, value),
    delete: (key: string) => deleteStoredState(pluginId, key),
  };
}

/** Reads plugin-owned state persisted across app restarts. */
export async function getStoredState<T>(
  pluginId: string,
  key: string,
  initialValue: T,
): Promise<T> {
  const raw = await getBridge().actions.storage.get(pluginId, key);
  return raw === null ? initialValue : (JSON.parse(raw) as T);
}

/** Writes plugin-owned state persisted across app restarts. */
export async function setStoredState<T>(pluginId: string, key: string, value: T): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Plugin stored state must be JSON-serializable");
  }
  await getBridge().actions.storage.set(pluginId, key, serialized);
}

/** Deletes plugin-owned state persisted across app restarts. */
export function deleteStoredState(pluginId: string, key: string): Promise<void> {
  return getBridge().actions.storage.delete(pluginId, key);
}
