import { useId, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** Persists a built-in control through the optional sandbox host bridge. */
export function useLocalState<T>(initial: T, key?: string): [T, Dispatch<SetStateAction<T>>] {
  const id = useId();
  const storageId = key ?? id;
  const [value, setValue] = useState<T>(() => {
    const saved = globalThis.pragmaScratchpad?.getLocalState?.(storageId);
    return saved === undefined ? initial : (saved as T);
  });
  const current = useRef(value);
  const update: Dispatch<SetStateAction<T>> = (next) => {
    const result = typeof next === "function" ? (next as (value: T) => T)(current.current) : next;
    current.current = result;
    globalThis.pragmaScratchpad?.setLocalState?.(storageId, result);
    setValue(result);
  };
  return [value, update];
}
