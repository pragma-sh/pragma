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
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { hapticSelection } from "@/lib/haptics";
import { useThemeColors } from "@/lib/theme";
import { isStale, type UsageLimits } from "@/lib/use-usage-limits";
import { useWideLayout } from "@/lib/use-wide-layout";
import { cn } from "@/lib/utils";
import { AgentIcon } from "./AgentIcon";
import { IconSymbol } from "./IconSymbol";
import { Text } from "./ui/text";

/** How often the "last updated" label re-reads the clock. */
const STALE_LABEL_TICK_MS = 30_000;

/** Expand/collapse timings. Short enough to feel like a direct response. */
const EXPAND_MS = 180;
const CHEVRON_MS = 160;

/** Bar fill per severity band, mirroring the desktop popover's colors. */
const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

/**
 * Grid basis per card. `flexBasis` (not a fixed width) is what makes these a
 * grid: cards wrap at a column count, then grow to share the leftover row,
 * and each row's cards stretch to the tallest — so an expanded card never
 * leaves its neighbour a different size.
 */
const CARD_BASIS = { narrow: "46%", wide: "30%" } as const;

type CardBasis = (typeof CARD_BASIS)[keyof typeof CARD_BASIS];

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
  const basis = wide ? CARD_BASIS.wide : CARD_BASIS.narrow;

  if (!usage.loading && usage.providers.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      <Text className="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Usage limits
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {usage.loading
          ? [0, 1].map((index) => <ProviderSkeleton basis={basis} key={index} />)
          : usage.providers.map((provider) => (
              <ProviderCard
                basis={basis}
                key={`${provider.pluginId}/${provider.providerId}`}
                provider={provider}
              />
            ))}
      </View>
    </View>
  );
}

/**
 * A card-shaped placeholder while the first read is in flight.
 *
 * It occupies the same grid cell as a real card so the section does not jump
 * when the readings land, and it pulses so a slow host reads as "loading"
 * rather than as a provider with nothing to say.
 */
function ProviderSkeleton({ basis }: { basis: CardBasis }) {
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 700 }), -1, true);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      accessibilityLabel="Loading usage limits"
      className="gap-3 overflow-hidden rounded-xl border border-border bg-card p-3"
      style={[{ flexGrow: 1, flexBasis: basis }, style]}
    >
      <View className="flex-row items-center gap-2">
        <View className="h-[18px] w-[18px] rounded-full bg-muted" />
        <View className="h-3 flex-1 rounded-full bg-muted" />
      </View>
      <View className="h-1 rounded-full bg-muted" />
    </Animated.View>
  );
}

/** One provider: a collapsed summary row that expands to every category. */
function ProviderCard({ basis, provider }: { basis: CardBasis; provider: UsageLimitsProvider }) {
  const [expanded, setExpanded] = useState(false);
  const primary = resolvePrimaryLimit(provider.primaryLimitId, provider.result);
  const staleLabel = useStaleLabel(provider);

  return (
    <Animated.View
      className="overflow-hidden rounded-xl border border-border bg-card"
      layout={LinearTransition.duration(EXPAND_MS)}
      style={{ flexGrow: 1, flexBasis: basis }}
    >
      <Pressable
        accessibilityHint="Shows every usage category this provider reports"
        accessibilityLabel={`${provider.title} usage`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="gap-2 p-3 active:opacity-70"
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
          <Chevron expanded={expanded} />
        </View>
        {primary ? <UsageBar limit={primary} /> : <ProviderStatus provider={provider} />}
        {staleLabel ? (
          <Text className="text-[11px] text-muted-foreground">{staleLabel}</Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <Animated.View entering={FadeIn.duration(EXPAND_MS)} exiting={FadeOut.duration(EXPAND_MS)}>
          <ProviderDetail provider={provider} />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

/**
 * The disclosure chevron: one glyph that rotates, rather than two that swap.
 *
 * It is tinted from the resolved theme colors because an SF Symbol takes a
 * literal `tintColor` prop and cannot read a NativeWind class — left untinted
 * it would ignore the user's theme and paint itself the system label color.
 */
function Chevron({ expanded }: { expanded: boolean }) {
  const { mutedForeground } = useThemeColors();
  const turn = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    turn.value = withTiming(expanded ? 1 : 0, { duration: CHEVRON_MS });
  }, [expanded, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));

  return (
    <Animated.View style={style}>
      <IconSymbol
        className="text-muted-foreground"
        color={mutedForeground}
        fallback="⌄"
        name="chevron.down"
        size={12}
        tintColor={mutedForeground}
      />
    </Animated.View>
  );
}

function ProviderDetail({ provider }: { provider: UsageLimitsProvider }) {
  const result = provider.result;
  return (
    <View className="gap-3 border-t border-border p-3">
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
