import { useContext, type Context } from "react";

/**
 * Reads a required React context, throwing a clear error when a hook is used
 * outside its provider. Centralizes the "must be used within a provider" guard
 * shared by the app's context hooks (`useAi`, `useWorkspace`, …).
 */
export function useRequiredContext<T>(context: Context<T | null>, hookName: string): T {
  const value = useContext(context);
  if (value === null) {
    throw new Error(`${hookName} must be used within its provider`);
  }
  return value;
}
