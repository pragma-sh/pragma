import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, de-duplicating conflicting utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** A message to show the user for a thrown value, with a usable fallback. */
export function errorText(cause: unknown, fallback = "Try again."): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
