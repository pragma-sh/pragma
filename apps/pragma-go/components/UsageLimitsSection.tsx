import {
  formatDuration,
  percentUsed,
  resetsInMs,
  resolvePrimaryLimit,
  usagePercentLabel,
  usageSeverity,
  type UsageLimit,
  type UsageLimitsProvider,
} from "@pragma/constants";
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { hapticSelection } from "@/lib/haptics";
import { isStale, type UsageLimits } from "@/lib/use-usage-limits";
import { useWideLayout } from "@/lib/use-wide-layout";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./AgentIcon";
import { IconSymbol } from "./IconSymbol";
import { Text } from "./ui/text";

/** How often the "last updated" label re-reads the clock. */
const STALE_LABEL_TICK_MS = 30_000;

/** Bar fill per severity band, mirroring the desktop popover's colors. */
const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

/**
 * The home screen's usage-limit cards.
 *
 * Renders nothing at all when the host has no usage providers — an absent
 * section is the honest answer, and is deliberately different from a provider
 * that exists but cannot report. It also stays mounted through a failed read,
 * showing the last good numbers with a stale label rather than blanking or,
 * worse, implying zero usage.
 */
export function UsageLimitsSection({ usage }: { usage: UsageLimits }) {
  const wide = useWideLayout();
  if (usage.loading || usage.providers.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      <Text className="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Usage limits
      </Text>
      <View className={cn("gap-3", wide && "flex-row flex-wrap")}>
        {usage.providers.map((provider) => (
          <ProviderCard
            key={`${provider.pluginId}/${provider.providerId}`}
            className={wide ? "min-w-[280px] flex-1" : undefined}
            provider={provider}
          />
        ))}
      </View>
    </View>
  );
}

/** One provider: a collapsed summary row that expands to every category. */
function ProviderCard({
  className,
  provider,
}: {
  className?: string;
  provider: UsageLimitsProvider;
}) {
  const [expanded, setExpanded] = useState(false);
  const primary = resolvePrimaryLimit(provider.primaryLimitId, provider.result);
  const staleLabel = useStaleLabel(provider);

  return (
    <View className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <Pressable
        accessibilityHint="Shows every usage category this provider reports"
        accessibilityLabel={`${provider.title} usage`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="gap-2 p-4 active:opacity-70"
        onPress={() => {
          hapticSelection();
          setExpanded((open) => !open);
        }}
      >
        <View className="flex-row items-center gap-2">
          <AgentIcon fallback="◔" icon={provider.icon} size={18} />
          <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
            {provider.title}
          </Text>
          {primary ? (
            <Text className="text-xs text-muted-foreground">{usagePercentLabel(primary)}</Text>
          ) : null}
          <IconSymbol
            className="text-muted-foreground"
            fallback={expanded ? "⌃" : "⌄"}
            name={expanded ? "chevron.up" : "chevron.down"}
            size={12}
          />
        </View>
        {primary ? <UsageBar limit={primary} /> : <ProviderStatus provider={provider} />}
        {staleLabel ? (
          <Text className="text-[11px] text-muted-foreground">{staleLabel}</Text>
        ) : null}
      </Pressable>
      {expanded ? <ProviderDetail provider={provider} /> : null}
    </View>
  );
}

function ProviderDetail({ provider }: { provider: UsageLimitsProvider }) {
  const result = provider.result;
  return (
    <View className="gap-3 border-t border-border p-4">
      {result?.status === "ready" ? (
        result.limits.map((limit) => (
          <LimitRow key={limit.id} limit={limit} observedAt={result.observedAt} />
        ))
      ) : (
        <ProviderStatus provider={provider} verbose />
      )}
      <Pressable
        accessibilityRole="link"
        className="flex-row items-center gap-1 active:opacity-70"
        onPress={() => void Linking.openURL(provider.dashboardUrl)}
      >
        <Text className="text-xs font-medium text-foreground">View dashboard</Text>
        <IconSymbol fallback="↗" name="arrow.up.right" size={11} />
      </Pressable>
    </View>
  );
}

function LimitRow({ limit, observedAt }: { limit: UsageLimit; observedAt: number }) {
  const resetsIn = resetsInMs(limit, observedAt);
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs font-medium text-foreground">{limit.title}</Text>
        <Text className="text-xs text-muted-foreground">{usagePercentLabel(limit)}</Text>
      </View>
      <UsageBar limit={limit} />
      {resetsIn === null ? null : (
        <Text className="text-[11px] text-muted-foreground">
          Resets in {formatDuration(resetsIn)}
        </Text>
      )}
    </View>
  );
}

/**
 * The bar itself. An unlimited category gets an empty track rather than a full
 * or empty *fill*, because either would read as a usage figure it does not have.
 */
function UsageBar({ limit }: { limit: UsageLimit }) {
  const percent = percentUsed(limit);
  if (percent === null) {
    return <View className="h-1 rounded-full bg-muted" />;
  }
  return (
    <View
      accessibilityLabel={`${limit.title}: ${Math.round(percent)}% used`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      className="h-1 overflow-hidden rounded-full bg-muted"
    >
      <View
        className={cn("h-full rounded-full", BAR_CLASS[usageSeverity(percent)])}
        style={{ width: `${percent}%` }}
      />
    </View>
  );
}

/**
 * How old a reading is, once it is old enough to say so.
 *
 * The label is state on a slow timer rather than a `Date.now()` read during
 * render: a card that says "3m ago" has to become "4m ago" on its own, and
 * reading the clock while rendering makes the same props paint differently.
 */
function useStaleLabel(provider: UsageLimitsProvider): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const update = (): void => {
      const now = Date.now();
      setLabel(
        isStale(provider, now)
          ? `Last updated ${formatDuration(now - (provider.observedAt ?? now))} ago`
          : null,
      );
    };
    update();
    const timer = setInterval(update, STALE_LABEL_TICK_MS);
    return () => clearInterval(timer);
  }, [provider]);
  return label;
}

/** Why a provider is showing no bar: never phrased as zero usage. */
function ProviderStatus({
  provider,
  verbose = false,
}: {
  provider: UsageLimitsProvider;
  verbose?: boolean;
}) {
  const message =
    provider.result?.status === "unavailable" ? provider.result.message : "No usage data yet";
  return (
    <Text className="text-[11px] text-muted-foreground" numberOfLines={verbose ? undefined : 1}>
      {message}
    </Text>
  );
}
