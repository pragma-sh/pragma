import type { ReactNode } from "react";

/** Titled panel that every Settings section is built from. */
export function SettingsCard({
  title,
  description,
  icon,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** A small mark before the title, such as a provider's logo. */
  icon?: ReactNode;
  /** Controls on the right of the title row. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-semibold">
            {icon}
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}
