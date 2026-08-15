import { useEffect } from "react";
import { Toaster as Sonner, toast, type ToasterProps, useSonner } from "sonner";

/**
 * Maximum number of toasts kept mounted at once. Sonner keeps *every* toast in
 * the DOM — the ones past `visibleToasts` are only hidden, not unmounted — and
 * each mounted toast carries its own timers, height observer and transitions,
 * so a pile of them makes the whole window lag. Anything past this cap is
 * dismissed oldest-first so it actually unmounts.
 */
const MAX_MOUNTED_TOASTS = 10;

/** Dismisses the oldest toasts so at most `max` stay mounted. */
const useToastLimit = (max: number) => {
  const { toasts } = useSonner();

  useEffect(() => {
    if (toasts.length <= max) return;
    // `useSonner` returns newest-first, so everything past the cap is the
    // oldest. Dismissing plays the exit transition and then unmounts.
    for (const stale of toasts.slice(max)) {
      toast.dismiss(stale.id);
    }
  }, [toasts, max]);
};

const Toaster = ({ ...props }: ToasterProps) => {
  useToastLimit(MAX_MOUNTED_TOASTS);

  return (
    <Sonner
      className="toaster group"
      style={
        {
          // Pin the toast width so custom (JSX) toasts — which sonner renders
          // with `data-styled="false"` and therefore *without* its default
          // width — match the standard toasts. The agent toast reads this same
          // var via `w-[var(--width)]`.
          "--width": "356px",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { MAX_MOUNTED_TOASTS, Toaster };
