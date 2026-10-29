import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** Slots held by mounted controls, per label. One sandboxed frame renders one scratchpad block. */
const claimedSlots = new Map<string, Set<number>>();

/**
 * A storage key for one control, unique among the controls mounted with the same label:
 * the label plus the lowest slot no other mounted control holds. Mount order decides the
 * slot, so the controls of a block keep their saved state when it is reopened or remounted.
 */
export function useControlKey(label: string): string {
  const [claim] = useState(() => claimSlot(label));
  useEffect(() => claim.release, [claim]);
  return claim.key;
}

function claimSlot(label: string): { key: string; release: () => void } {
  const slots = claimedSlots.get(label) ?? new Set<number>();
  claimedSlots.set(label, slots);
  let slot = 0;
  while (slots.has(slot)) slot++;
  slots.add(slot);
  return { key: `${label}#${slot}`, release: () => void slots.delete(slot) };
}

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
