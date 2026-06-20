import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
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

export { Toaster };
