import { useEffect, useRef, useState } from "react";

import type { UsageLimit, UsageLimitProviderDefinition, UsageLimitsResult } from "@pragma/plugin";
import { ArrowUpRight, CircleGauge, Gauge } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
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
import {
  pluginContextForRecord,
  usePluginUsageLimitProviders,
  type VisiblePluginContribution,
} from "@/plugins/rendering";

const MIN_REFRESH_INTERVAL_MS = 15_000;
const MAX_RETRY_INTERVAL_MS = 15 * 60_000;
const recordIds = new WeakMap<object, number>();
let nextRecordId = 1;

interface ProviderState {
  result?: UsageLimitsResult;
  error?: string;
  loading: boolean;
}

/** Shared top-bar entry point for plugin-provided usage limits. */
export function UsageLimitsPopover({ activeProjectId }: { activeProjectId: string | null }) {
  const providers = usePluginUsageLimitProviders(activeProjectId);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const runtime = usePluginRuntimeState();
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const providerSignature = providers
    .map((provider) => `${provider.key}:${recordId(provider.record)}`)
    .join("\u0000");

  useEffect(() => {
    if (!runtime.sdk) {
      return;
    }

    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const activeProviders = providersRef.current;

    setStates((current) => {
      const next: Record<string, ProviderState> = {};
      for (const provider of activeProviders) {
        next[provider.key] = current[provider.key] ?? { loading: true };
      }
      return next;
    });

    for (const provider of activeProviders) {
      let failures = 0;
      let inFlight = false;
      const requestedInterval = provider.contribution.refreshIntervalMs;
      const refreshInterval =
        requestedInterval === undefined || !Number.isFinite(requestedInterval)
          ? MIN_REFRESH_INTERVAL_MS
          : Math.max(MIN_REFRESH_INTERVAL_MS, requestedInterval);

      const schedule = (delay: number) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          void refresh();
        }, delay);
        timers.add(timer);
      };

      const refresh = async () => {
        if (disposed || inFlight) {
          return;
        }
        inFlight = true;
        try {
          const result = validateUsageLimitsResult(
            provider.contribution,
            await provider.contribution.load(pluginContextForRecord(provider.record, runtime)),
          );
          failures = 0;
          if (!disposed) {
            setStates((current) => ({
              ...current,
              [provider.key]: { result, loading: false },
            }));
          }
        } catch (cause) {
          failures += 1;
          if (!disposed) {
            setStates((current) => ({
              ...current,
              [provider.key]: {
                ...current[provider.key],
                error: cause instanceof Error ? cause.message : String(cause),
                loading: false,
              },
            }));
          }
        } finally {
          inFlight = false;
          if (!disposed) {
            schedule(
              failures === 0
                ? refreshInterval
                : Math.min(refreshInterval * 2 ** failures, MAX_RETRY_INTERVAL_MS),
            );
          }
        }
      };

      void refresh();
    }

    return () => {
      disposed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [providerSignature, refreshNonce, runtime]);

  if (providers.length === 0) {
    return null;
  }

  return (
    <Popover onOpenChange={(open) => open && setRefreshNonce((current) => current + 1)}>
      <PopoverTrigger asChild>
        <Button aria-label="Usage limits" size="icon-sm" variant="ghost">
          <Gauge />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 gap-1 p-2">
        <PopoverHeader className="px-2 py-1">
          <PopoverTitle>Usage limits</PopoverTitle>
        </PopoverHeader>
        <Accordion type="multiple">
          {providers.map((provider) => (
            <ProviderAccordionItem
              key={provider.key}
              provider={provider}
              state={states[provider.key] ?? { loading: true }}
            />
          ))}
        </Accordion>
      </PopoverContent>
    </Popover>
  );
}

/** Picks the limit shown on the collapsed accordion row, if any. */
function resolvePrimaryLimit(
  definition: UsageLimitProviderDefinition,
  result: UsageLimitsResult | undefined,
): UsageLimit | undefined {
  if (result?.status !== "ready") {
    return undefined;
  }
  return result.summary ?? result.limits.find((limit) => limit.id === definition.primaryLimitId);
}

function ProviderAccordionItem({
  provider,
  state,
}: {
  provider: VisiblePluginContribution<UsageLimitProviderDefinition>;
  state: ProviderState;
}) {
  const definition = provider.contribution;
  const primary = resolvePrimaryLimit(definition, state.result);

  return (
    <AccordionItem className="rounded-md border px-2 not-last:mb-1" value={provider.key}>
      <AccordionTrigger className="items-center gap-2 py-2 hover:no-underline">
        <ProviderIcon definition={definition} provider={provider} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{definition.title}</span>
            <span className="text-[11px] font-normal text-muted-foreground">
              {primary ? usagePercentLabel(primary) : null}
            </span>
          </div>
          {primary ? <UsageProgress limit={primary} /> : <ProviderStatus state={state} />}
        </div>
      </AccordionTrigger>
      <ProviderAccordionContent definition={definition} state={state} />
    </AccordionItem>
  );
}

function ProviderAccordionContent({
  definition,
  state,
}: {
  definition: UsageLimitProviderDefinition;
  state: ProviderState;
}) {
  const result = state.result;
  return (
    <AccordionContent className="flex flex-col gap-3 px-1 pb-3">
      {result?.status === "ready" ? (
        result.limits.map((limit) => (
          <UsageLimitRow key={limit.id} limit={limit} observedAt={result.observedAt} />
        ))
      ) : (
        <ProviderStatus state={state} verbose />
      )}
      {state.error && result?.status === "ready" ? (
        <p className="text-[11px] text-destructive">Update failed: {state.error}</p>
      ) : null}
      <Button
        className="self-start"
        size="sm"
        variant="outline"
        onClick={() => openUsageDashboard(definition.dashboardUrl)}
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
  definition,
  provider,
}: {
  definition: UsageLimitProviderDefinition;
  provider: VisiblePluginContribution<UsageLimitProviderDefinition>;
}) {
  const iconPath = resolvePluginAssetPath(definition.iconPath, provider.record);
  const needsInvert = useIconNeedsInvert(iconPath);
  if (definition.icon) {
    const Icon = definition.icon;
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

function ProviderStatus({ state, verbose = false }: { state: ProviderState; verbose?: boolean }) {
  const message = state.loading
    ? "Loading..."
    : state.result?.status === "unavailable"
      ? state.result.message
      : state.error
        ? state.error
        : "No usage data";
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{limit.title}</span>
        <span className="text-muted-foreground">{usagePercentLabel(limit)}</span>
      </div>
      <UsageProgress limit={limit} />
      {limit.resetsInMs === undefined ? null : (
        <span className="text-[11px] text-muted-foreground">
          Resets in {formatDuration(observedAt + limit.resetsInMs - Date.now())}
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

function recordId(record: object): number {
  const existing = recordIds.get(record);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextRecordId;
  nextRecordId += 1;
  recordIds.set(record, id);
  return id;
}

/** Calculates a bounded percentage from provider-reported quantities. */
export function percentUsed(limit: UsageLimit): number | null {
  if (limit.limit === null || limit.limit <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (limit.used / limit.limit) * 100));
}

/** Maps usage severity onto semantic progress colors. */
export function progressColorClass(percent: number): string {
  if (percent < 50) {
    return "[&_[data-slot=progress-indicator]]:bg-primary";
  }
  if (percent < 75) {
    return "[&_[data-slot=progress-indicator]]:bg-warning";
  }
  return "[&_[data-slot=progress-indicator]]:bg-destructive";
}

function usagePercentLabel(limit: UsageLimit): string {
  const percent = percentUsed(limit);
  return percent === null ? "Unlimited" : `${Math.round(percent)}% used`;
}

/** Formats a reset countdown without rounding partial days up. */
export function formatDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.ceil(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(minutes / (60 * 24))}d`;
}

function validateUsageLimitsResult(
  provider: UsageLimitProviderDefinition,
  result: UsageLimitsResult,
): UsageLimitsResult {
  if (result.status === "unavailable") {
    return result;
  }
  if (!Number.isFinite(result.observedAt)) {
    throw new Error(`${provider.title} returned an invalid observation time`);
  }
  const ids = new Set<string>();
  for (const limit of result.limits) {
    if (ids.has(limit.id) || !isValidUsageLimit(limit)) {
      throw new Error(`${provider.title} returned an invalid usage limit`);
    }
    ids.add(limit.id);
  }
  if (result.summary !== undefined && !isValidUsageLimit(result.summary)) {
    throw new Error(`${provider.title} returned an invalid summary limit`);
  }
  if (!ids.has(provider.primaryLimitId)) {
    throw new Error(`${provider.title} did not return primary limit "${provider.primaryLimitId}"`);
  }
  return result;
}

function isValidUsageLimit(limit: UsageLimit): boolean {
  return (
    Boolean(limit.id) &&
    Boolean(limit.title) &&
    hasValidUsedAmount(limit) &&
    hasValidLimitAmount(limit) &&
    hasValidResetsIn(limit)
  );
}

function hasValidUsedAmount(limit: UsageLimit): boolean {
  return Number.isFinite(limit.used) && limit.used >= 0;
}

function hasValidLimitAmount(limit: UsageLimit): boolean {
  return limit.limit === null || (Number.isFinite(limit.limit) && limit.limit > 0);
}

function hasValidResetsIn(limit: UsageLimit): boolean {
  return (
    limit.resetsInMs === undefined || (Number.isFinite(limit.resetsInMs) && limit.resetsInMs >= 0)
  );
}
