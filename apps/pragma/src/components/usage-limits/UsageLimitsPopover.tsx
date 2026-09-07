import { useEffect, useMemo, useState } from "react";

import {
  constants,
  formatDuration,
  isStaleReading,
  percentUsed,
  resetsInMs,
  resolvePrimaryLimit,
  usagePercentLabel,
  usageSeverity,
  type UsageLimit,
  type UsageLimitsProvider,
} from "@pragma/constants";
import type { UsageLimitProviderDefinition } from "@pragma/plugin";
import { ArrowUpRight, CircleGauge, Gauge } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useIconNeedsInvert } from "@/lib/icon-contrast";
import { browserOpenExternal } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { resolvePluginAssetPath } from "@/plugins/assets";
import { usePluginRuntimeState } from "@/plugins/host-hooks";
import { usePluginUsageLimitProviders, type VisiblePluginContribution } from "@/plugins/rendering";

/** Fallback poll while the popover is open, when no provider asks for slower. */
const OPEN_POLL_MS = constants.usageLimits.minRefreshIntervalMs;

/**
 * Shared top-bar entry point for plugin-provided usage limits.
 *
 * The readings come from the host, which owns the cache, the per-provider
 * cadence, the backoff after a failure, and the validation. Asking more often
 * than the host's own floor costs a provider nothing — the host answers from
 * cache — so this simply asks while the user is looking.
 */
export function UsageLimitsPopover({ activeProjectId }: { activeProjectId: string | null }) {
  const runtime = usePluginRuntimeState();
  const root = runtime.project?.path;
  const [providers, setProviders] = useState<UsageLimitsProvider[]>([]);
  const [open, setOpen] = useState(false);
  const icons = useProviderIcons(activeProjectId);

  useEffect(() => {
    const sdk = runtime.sdk;
    if (!sdk) {
      return undefined;
    }
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await sdk.usageLimits.get(root ? { root } : {});
        if (!disposed) {
          setProviders(next);
        }
      } catch {
        // The host is the source of truth and keeps the last good readings;
        // a failed poll leaves what is already on screen alone.
      }
    };
    void refresh();
    // Poll only while the popover is open: closed, the cards are not visible
    // and the host's cache is what the next open will read anyway.
    const timer = open ? setInterval(() => void refresh(), OPEN_POLL_MS) : undefined;
    return () => {
      disposed = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, [open, root, runtime.sdk]);

  if (providers.length === 0) {
    return null;
  }

  return (
    <Popover onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Usage limits" size="icon-sm" variant="ghost">
          <Gauge />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 gap-1 p-2">
        <PopoverHeader className="px-2 py-1">
          <PopoverTitle>Usage limits</PopoverTitle>
        </PopoverHeader>
        <Accordion type="multiple">
          {providers.map((provider) => (
            <ProviderAccordionItem
              key={providerKey(provider)}
              icon={icons.get(providerKey(provider))}
              provider={provider}
            />
          ))}
        </Accordion>
      </PopoverContent>
    </Popover>
  );
}

/** Stable identity of a provider across the host response and the local runtime. */
function providerKey(provider: Pick<UsageLimitsProvider, "pluginId" | "providerId">): string {
  return `${provider.pluginId} ${provider.providerId}`;
}

/**
 * Icons still come from the desktop's own plugin runtime: a provider may declare
 * its icon as a React component, which has no wire form. The host's `icon` hash
 * covers file icons for clients that cannot load plugin code; here the local
 * definition is richer, so it wins.
 */
function useProviderIcons(
  activeProjectId: string | null,
): Map<string, VisiblePluginContribution<UsageLimitProviderDefinition>> {
  const contributions = usePluginUsageLimitProviders(activeProjectId);
  return useMemo(
    () =>
      new Map(
        contributions.map((contribution) => [
          providerKey({
            pluginId: contribution.pluginId,
            providerId: contribution.contribution.id,
          }),
          contribution,
        ]),
      ),
    [contributions],
  );
}

function ProviderAccordionItem({
  icon,
  provider,
}: {
  icon?: VisiblePluginContribution<UsageLimitProviderDefinition>;
  provider: UsageLimitsProvider;
}) {
  const primary = resolvePrimaryLimit(provider.primaryLimitId, provider.result);

  return (
    <AccordionItem className="rounded-md border px-2 not-last:mb-1" value={providerKey(provider)}>
      <AccordionTrigger className="items-center gap-2 py-2 hover:no-underline">
        <ProviderIcon icon={icon} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{provider.title}</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {primary ? usagePercentLabel(primary) : null}
            </span>
          </div>
          {primary ? <UsageProgress limit={primary} /> : <ProviderStatus provider={provider} />}
        </div>
      </AccordionTrigger>
      <ProviderAccordionContent provider={provider} />
    </AccordionItem>
  );
}

function ProviderAccordionContent({ provider }: { provider: UsageLimitsProvider }) {
  const result = provider.result;
  return (
    <AccordionContent className="flex flex-col gap-3 px-1 pb-3">
      {result?.status === "ready" ? (
        result.limits.map((limit) => (
          <UsageLimitRow key={limit.id} limit={limit} observedAt={result.observedAt} />
        ))
      ) : (
        <ProviderStatus provider={provider} verbose />
      )}
      {isStaleReading(provider, constants.usageLimits.staleAfterMs) ? (
        <p className="text-[11px] text-muted-foreground">
          Last updated {formatDuration(Date.now() - (provider.observedAt ?? 0))} ago
        </p>
      ) : null}
      <Button
        className="self-start"
        size="sm"
        variant="outline"
        onClick={() => openUsageDashboard(provider.dashboardUrl)}
      >
        View dashboard
        <ArrowUpRight />
      </Button>
    </AccordionContent>
  );
}

/** Opens a provider's usage dashboard in the user's default browser. */
export function openUsageDashboard(url: string): void {
  void browserOpenExternal(url);
}

function ProviderIcon({
  icon,
}: {
  icon?: VisiblePluginContribution<UsageLimitProviderDefinition>;
}) {
  const iconPath = icon
    ? resolvePluginAssetPath(icon.contribution.iconPath, icon.record)
    : undefined;
  const needsInvert = useIconNeedsInvert(iconPath);
  const Icon = icon?.contribution.icon;
  if (Icon) {
    return <Icon className="size-4 shrink-0" />;
  }
  return iconPath ? (
    <img
      alt=""
      className={cn("size-4 shrink-0 rounded-sm", needsInvert && "invert")}
      src={iconPath}
    />
  ) : (
    <CircleGauge className="size-4 shrink-0 text-muted-foreground" />
  );
}

/** Why a provider is showing no bar. Never phrased, or drawn, as zero usage. */
function ProviderStatus({
  provider,
  verbose = false,
}: {
  provider: UsageLimitsProvider;
  verbose?: boolean;
}) {
  const message =
    provider.result?.status === "unavailable" ? provider.result.message : "No usage data";
  return (
    <p
      className={cn(
        "truncate text-left text-[11px] font-normal text-muted-foreground",
        verbose && "whitespace-normal",
      )}
    >
      {message}
    </p>
  );
}

function UsageLimitRow({ limit, observedAt }: { limit: UsageLimit; observedAt: number }) {
  const resetsIn = resetsInMs(limit, observedAt);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{limit.title}</span>
        <span className="text-muted-foreground">{usagePercentLabel(limit)}</span>
      </div>
      <UsageProgress limit={limit} />
      {resetsIn === null ? null : (
        <span className="text-[11px] text-muted-foreground">
          Resets in {formatDuration(resetsIn)}
        </span>
      )}
    </div>
  );
}

function UsageProgress({ limit }: { limit: UsageLimit }) {
  const percent = percentUsed(limit);
  return percent === null ? (
    <div className="h-1 rounded-full bg-muted" />
  ) : (
    <Progress
      aria-label={`${limit.title}: ${Math.round(percent)}% used`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={progressColorClass(percent)}
      value={percent}
    />
  );
}

/** Maps usage severity onto this app's semantic progress colors. */
export function progressColorClass(percent: number): string {
  const severity = usageSeverity(percent);
  if (severity === "ok") {
    return "[&_[data-slot=progress-indicator]]:bg-primary";
  }
  if (severity === "warning") {
    return "[&_[data-slot=progress-indicator]]:bg-warning";
  }
  return "[&_[data-slot=progress-indicator]]:bg-destructive";
}
