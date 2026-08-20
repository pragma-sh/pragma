/** Imperative durable JSON storage bound by the host to one plugin. */
export interface PluginStorage {
  get<T>(key: string, initialValue: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
