import * as SecureStore from "expo-secure-store";

// Native: the OS keychain, unchanged. The web build swaps in `secret-store.web.ts`,
// which has no keychain to reach for. Everything that persists a token or a
// device id goes through this seam so neither platform imports the other's
// storage directly.

/** Reads a stored value, or null when absent. */
export async function getItemAsync(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

/** Persists a value. */
export async function setItemAsync(key: string, value: string): Promise<void> {
  return SecureStore.setItemAsync(key, value);
}

/** Removes a stored value. */
export async function deleteItemAsync(key: string): Promise<void> {
  return SecureStore.deleteItemAsync(key);
}

/**
 * Whether persistence survives closing the app. True on device (keychain);
 * false in a browser tab that opted out of remembering this machine.
 */
export function isPersistent(): boolean {
  return true;
}

/**
 * Opts this client into storage that outlives the session. A no-op on native,
 * where the keychain is always durable.
 */
export function setPersistent(_persistent: boolean): void {
  // Native storage is durable by construction; nothing to switch.
}
