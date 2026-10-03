import { useState, type ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import { UsageBar } from "@/components/accounts/UsageBar";
import type { AccountView } from "@/lib/accounts";
import { formatDuration, percentUsed, usagePercentLabel } from "@/lib/usage-limits";
import { cn } from "@/lib/utils";

/**
 * The toolbar menu's account: its primary usage at a glance; click to expand
 * every limit. Switching happens on the provider's harness rows, not here.
 */
export function AccountRow({ account }: { account: AccountView }) {
  const [expanded, setExpanded] = useState(false);
  const idle = account.usedBy.length === 0;
  return (
    <div
      className={cn(
        "rounded-md transition-colors hover:bg-accent/50",
        idle && "opacity-70 hover:opacity-100",
      )}
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <AccountAvatar account={account} className="size-6 text-[11px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium">{account.label}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {account.primary ? usagePercentLabel(account.primary) : null}
            </span>
          </span>
          <AccountSubtitle account={account} />
          {account.primary ? <UsageBar percent={account.primaryPercent} /> : null}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="px-2 pt-1 pb-2 pl-10.5">
          <AccountLimits account={account} wide={false} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Settings page's account: identity, every limit, then `footer`. Nothing
 * collapses. `name` replaces the plain label, e.g. with a rename field.
 */
export function AccountCard({
  account,
  footer,
  name,
}: {
  account: AccountView;
  footer?: ReactNode;
  name?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <AccountAvatar account={account} className="size-9 text-sm" />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          {name ?? <span className="truncate text-sm font-medium">{account.label}</span>}
          <AccountSubtitle account={account} />
        </div>
        {account.usedBy.length === 0 ? (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
            Not in use
          </span>
        ) : null}
      </div>
      <AccountLimits account={account} wide />
      {footer}
    </div>
  );
}

function AccountAvatar({ account, className }: { account: AccountView; className: string }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full border bg-secondary font-semibold text-secondary-foreground",
        className,
      )}
    >
      {account.label.charAt(0).toUpperCase()}
    </span>
  );
}

function AccountSubtitle({ account }: { account: AccountView }) {
  const parts = [account.email !== account.label ? account.email : null, account.plan].filter(
    Boolean,
  );
  if (account.usage?.status === "unavailable") {
    return (
      <span className="truncate text-[11px] text-muted-foreground">{account.usage.message}</span>
    );
  }
  return parts.length > 0 ? (
    <span className="truncate text-[11px] text-muted-foreground">{parts.join(" · ")}</span>
  ) : null;
}

function AccountLimits({ account, wide }: { account: AccountView; wide: boolean }) {
  const result = account.usage;
  if (result?.status !== "ready") {
    return (
      <p className="text-[11px] text-muted-foreground">{result?.message ?? "Loading usage…"}</p>
    );
  }
  return (
    <div className={cn("grid gap-2", wide && "gap-x-8 gap-y-3 sm:grid-cols-2")}>
      {result.limits.map((limit) => (
        <div className="flex flex-col gap-1" key={limit.id}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="truncate font-medium">{limit.title}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {usagePercentLabel(limit)}
              {limit.resetsInMs === undefined
                ? null
                : ` · resets in ${formatDuration(result.observedAt + limit.resetsInMs - Date.now())}`}
            </span>
          </div>
          <UsageBar percent={percentUsed(limit)} />
        </div>
      ))}
    </div>
  );
}
